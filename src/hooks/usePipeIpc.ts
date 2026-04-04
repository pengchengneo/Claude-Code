/**
 * usePipeIpc — Slave-side named pipe IPC hook
 *
 * Responsibilities:
 * 1. On mount: create a PipeServer for this CLI session (always)
 * 2. Handle attach_request → accept/reject based on current state
 * 3. When attached (slave mode):
 *    - Receive `prompt` messages → inject via onSubmitMessage (same path as useInboxPoller)
 *    - Relay AI output back to master via `stream`/`done` messages
 * 4. Handle detach → return to standalone mode
 * 5. On unmount: close server, clean up socket file
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
 * Uses first 8 chars of the UUID for brevity.
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

  // Refs to hold long-lived objects across renders
  const serverRef = useRef<PipeServer | null>(null)
  const masterSocketRef = useRef<Socket | null>(null)

  // ----- Send helper (slave → master) -----
  const sendToMaster = useCallback((msg: PipeMessage) => {
    const server = serverRef.current
    const masterSocket = masterSocketRef.current
    if (server && masterSocket && !masterSocket.destroyed) {
      server.sendTo(masterSocket, msg)
    }
  }, [])

  // Expose sendToMaster for REPL to call when AI produces output
  // We store it on the server instance for easy access
  const sendToMasterRef = useRef(sendToMaster)
  sendToMasterRef.current = sendToMaster

  // ----- Start server on mount -----
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

        // Update AppState with our pipe name
        setAppState((prev) => ({
          ...prev,
          pipeIpc: { ...prev.pipeIpc, serverName: pipeName },
        }))

        // Expose sendToMaster globally so REPL onQueryEvent can relay output
        // without importing hooks (avoids circular deps and closure issues).
        ;(globalThis as any).__pipeSendToMaster = (msg: PipeMessage) => {
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
        server.on('connection', (socket: Socket) => {
          logForDebugging(`[PipeIpc] New connection`)
        })

        server.onMessage((msg, reply) => {
          if (msg.type === 'attach_request') {
            const currentState = store.getState()

            if (currentState.pipeIpc.role === 'slave') {
              // Already attached by someone else
              reply({
                type: 'attach_reject',
                data: `Already attached by ${currentState.pipeIpc.attachedBy}`,
              })
              logForDebugging(`[PipeIpc] Rejected attach from ${msg.from}: already attached`)
              return
            }

            // Accept the attach
            // We need to find the socket that sent this message.
            // Since reply() writes to the correct socket, we use it.
            // But we also need a reference to the socket for future sends.
            // The server emits 'connection' with the socket, but we can't
            // easily correlate. Instead, we iterate clients to find the newest.
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

            // Wrap in XML tag (same pattern as useInboxPoller)
            const formatted = `<${PIPE_IPC_TAG} from="${msg.from ?? 'master'}">\n${promptText}\n</${PIPE_IPC_TAG}>`

            const submitted = onSubmitMessage(formatted)
            if (!submitted) {
              // Session is busy — send error back to master
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
          attachedTo: null,
          attachedBy: null,
        },
      }))
    }
  }, [enabled, setAppState, store, onSubmitMessage])
}

/**
 * Module-level ref for the sendToMaster function.
 * Used by REPL to relay AI output to the master CLI.
 *
 * This is set by the usePipeIpc hook when a master is attached.
 */
let _globalSendToMaster: ((msg: PipeMessage) => void) | null = null

export function setGlobalPipeSendToMaster(fn: ((msg: PipeMessage) => void) | null): void {
  _globalSendToMaster = fn
}

export function getGlobalPipeSendToMaster(): ((msg: PipeMessage) => void) | null {
  return _globalSendToMaster
}
