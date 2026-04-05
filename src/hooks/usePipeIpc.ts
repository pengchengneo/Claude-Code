/**
 * usePipeIpc — Per-CLI named pipe IPC hook
 *
 * Every CLI instance auto-starts a PipeServer on mount.
 * Default role is 'standalone' — completely independent.
 *
 * When a master sends attach_request:
 *   - Accept → switch to 'slave' role
 *   - Begin auto-reporting all session events to master
 *
 * When a master sends prompt:
 *   - Inject via onSubmitMessage (same path as useInboxPoller)
 *
 * When a master sends detach:
 *   - Revert to standalone
 *
 * The globalThis.__pipeSendToMaster function is set when in slave mode
 * so that REPL's onQueryEvent can relay AI output without importing hooks.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { Socket } from 'net'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { getSessionId } from '../bootstrap/state.js'
import {
  createPipeServer,
  type PipeMessage,
  type PipeServer,
} from '../utils/pipeTransport.js'
import { logForDebugging } from '../utils/debug.js'

const PIPE_IPC_TAG = 'pipe_message'

/**
 * Generate a short pipe name from the session ID.
 */
function getSessionPipeName(): string {
  const sessionId = getSessionId()
  return `cli-${sessionId.slice(0, 8)}`
}

type Props = {
  enabled: boolean
  isLoading: boolean
  /** Same callback as useInboxPoller — injects content as a new turn */
  onSubmitMessage: (formatted: string) => boolean
}

export function usePipeIpc({ enabled, isLoading, onSubmitMessage }: Props): void {
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const pipeRole = useAppState((s) => s.pipeIpc.role)

  const serverRef = useRef<PipeServer | null>(null)
  // Track all connected master sockets (in slave mode, only one master at a time)
  const masterSocketRef = useRef<Socket | null>(null)

  // Send helper (slave → master)
  const sendToMaster = useCallback((msg: PipeMessage) => {
    const server = serverRef.current
    const masterSocket = masterSocketRef.current
    if (server && masterSocket && !masterSocket.destroyed) {
      server.sendTo(masterSocket, msg)
    }
  }, [])

  const sendToMasterRef = useRef(sendToMaster)
  sendToMasterRef.current = sendToMaster

  // Start server on mount
  useEffect(() => {
    if (!enabled) return

    const pipeName = getSessionPipeName()
    let server: PipeServer | null = null
    let disposed = false

    const init = async () => {
      try {
        server = await createPipeServer(pipeName)
        if (disposed) {
          await server.close()
          return
        }
        serverRef.current = server

        setAppState((prev) => ({
          ...prev,
          pipeIpc: { ...prev.pipeIpc, serverName: pipeName },
        }))

        // Expose sendToMaster globally so REPL onQueryEvent can relay output
        ;(globalThis as any).__pipeSendToMaster = (msg: PipeMessage) => {
          const currentState = store.getState()
          if (currentState.pipeIpc.role !== 'slave') return
          const masterSocket = masterSocketRef.current
          if (server && masterSocket && !masterSocket.destroyed) {
            server.sendTo(masterSocket, msg)
          }
        }

        logForDebugging(`[PipeIpc] Server started: ${pipeName}`)

        // --- Auto-reply to pings (health check) ---
        server.onMessage((msg, reply) => {
          if (msg.type === 'ping') {
            reply({ type: 'pong' })
          }
        })

        // --- Handle attach_request ---
        server.onMessage((msg, reply) => {
          if (msg.type === 'attach_request') {
            const currentState = store.getState()

            if (currentState.pipeIpc.role === 'slave') {
              reply({
                type: 'attach_reject',
                data: `Already controlled by ${currentState.pipeIpc.attachedBy}`,
              })
              logForDebugging(`[PipeIpc] Rejected attach from ${msg.from}: already slave`)
              return
            }

            // Accept the attach — find the latest client socket
            const clients = Array.from((server as any).clients as Set<Socket>)
            const latestClient = clients[clients.length - 1]
            if (latestClient) {
              masterSocketRef.current = latestClient

              // When master disconnects unexpectedly, revert to standalone
              latestClient.on('close', () => {
                if (masterSocketRef.current === latestClient) {
                  masterSocketRef.current = null
                  setAppState((prev) => ({
                    ...prev,
                    pipeIpc: {
                      ...prev.pipeIpc,
                      role: 'standalone',
                      attachedBy: null,
                    },
                  }))
                  logForDebugging(`[PipeIpc] Master disconnected, reverted to standalone`)
                }
              })
            }

            setAppState((prev) => ({
              ...prev,
              pipeIpc: {
                ...prev.pipeIpc,
                role: 'slave',
                attachedBy: msg.from ?? 'unknown',
              },
            }))

            reply({
              type: 'attach_accept',
              data: pipeName,
            })
            logForDebugging(`[PipeIpc] Accepted attach from ${msg.from}`)
          }
        })

        // --- Handle detach ---
        server.onMessage((msg, _reply) => {
          if (msg.type === 'detach') {
            masterSocketRef.current = null
            setAppState((prev) => ({
              ...prev,
              pipeIpc: {
                ...prev.pipeIpc,
                role: 'standalone',
                attachedBy: null,
              },
            }))
            logForDebugging(`[PipeIpc] Detached by ${msg.from}`)
          }
        })

        // --- Handle prompt (master → slave) ---
        server.onMessage((msg, _reply) => {
          if (msg.type === 'prompt') {
            const currentState = store.getState()
            if (currentState.pipeIpc.role !== 'slave') return

            const promptText = msg.data ?? ''
            if (!promptText) return

            logForDebugging(`[PipeIpc] Received prompt from master: ${promptText.slice(0, 50)}...`)

            const formatted = `<${PIPE_IPC_TAG} from="${msg.from ?? 'master'}">\n${promptText}\n</${PIPE_IPC_TAG}>`

            const submitted = onSubmitMessage(formatted)
            if (!submitted) {
              sendToMasterRef.current({
                type: 'error',
                data: 'Slave CLI is busy processing another request. Please wait.',
              })
            }
          }
        })
      } catch (err) {
        logForDebugging(`[PipeIpc] Failed to start server: ${err}`)
      }
    }

    void init()

    return () => {
      disposed = true
      ;(globalThis as any).__pipeSendToMaster = undefined
      if (serverRef.current) {
        void serverRef.current.close()
        serverRef.current = null
      }
      masterSocketRef.current = null
      setAppState((prev) => ({
        ...prev,
        pipeIpc: {
          role: 'standalone',
          serverName: null,
          slaves: {},
          attachedBy: null,
        },
      }))
    }
  }, [enabled, setAppState, store, onSubmitMessage])
}

/**
 * Relay a session event to the master CLI (if in slave mode).
 * Called from REPL's onQueryEvent handler.
 */
export function relayToMaster(msg: PipeMessage): void {
  const fn = (globalThis as any).__pipeSendToMaster as
    | ((msg: PipeMessage) => void)
    | undefined
  if (fn) {
    fn(msg)
  }
}
