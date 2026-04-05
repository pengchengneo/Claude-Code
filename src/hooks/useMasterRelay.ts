/**
 * useMasterRelay — Master-side named pipe relay hook
 *
 * When role === 'master', this hook:
 * 1. Listens to messages from the slave PipeClient
 * 2. Injects slave AI output (`stream`, `done`, `error`) into the master's display
 *    via onSubmitMessage (same path as teammate messages)
 * 3. Does nothing when role !== 'master'
 *
 * The actual user-input interception (sending prompts to slave instead of local AI)
 * is handled by the /attach command modifying the submit flow, not by this hook.
 */

import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppState.js'
import type { PipeClient, PipeMessage } from '../utils/pipeTransport.js'
import { logForDebugging } from '../utils/debug.js'

const PIPE_RELAY_TAG = 'pipe_relay'

type Props = {
  /** Should be true only when role === 'master' */
  enabled: boolean
  /** The connected PipeClient to the slave, or null */
  masterClient: PipeClient | null
  /** Inject content as a new turn (same as handleIncomingPrompt) */
  onSubmitMessage: (formatted: string) => boolean
}

/**
 * Module-level reference to the master's PipeClient.
 * Set by /attach command, read by useMasterRelay and REPL submit override.
 */
let _masterPipeClient: PipeClient | null = null

export function setMasterPipeClient(client: PipeClient | null): void {
  _masterPipeClient = client
}

export function getMasterPipeClient(): PipeClient | null {
  return _masterPipeClient
}

export function useMasterRelay({
  enabled,
  masterClient,
  onSubmitMessage,
}: Props): void {
  const role = useAppState((s) => s.pipeIpc.role)

  useEffect(() => {
    if (!enabled || role !== 'master' || !masterClient) return

    logForDebugging(`[MasterRelay] Listening to slave output`)

    // Accumulate stream fragments for the current turn
    let streamBuffer = ''

    const handler = (msg: PipeMessage) => {
      switch (msg.type) {
        case 'stream': {
          // Accumulate streamed output
          streamBuffer += msg.data ?? ''
          break
        }

        case 'done': {
          // Turn complete — inject accumulated output into the master's conversation
          const output = streamBuffer || msg.data || '(slave completed with no output)'
          streamBuffer = ''

          const formatted = `<${PIPE_RELAY_TAG} from="${msg.from ?? 'slave'}" type="response">\n${output}\n</${PIPE_RELAY_TAG}>`
          const submitted = onSubmitMessage(formatted)
          if (!submitted) {
            logForDebugging(`[MasterRelay] Failed to inject slave output (master busy)`)
          }
          break
        }

        case 'tool_start': {
          logForDebugging(`[MasterRelay] Slave tool: ${msg.data}`)
          break
        }

        case 'tool_result': {
          logForDebugging(`[MasterRelay] Slave tool result: ${(msg.data ?? '').slice(0, 100)}`)
          break
        }

        case 'error': {
          const formatted = `<${PIPE_RELAY_TAG} from="${msg.from ?? 'slave'}" type="error">\n${msg.data ?? 'Unknown error'}\n</${PIPE_RELAY_TAG}>`
          onSubmitMessage(formatted)
          break
        }

        case 'attach_reject': {
          logForDebugging(`[MasterRelay] Attach rejected: ${msg.data}`)
          break
        }

        default:
          break
      }
    }

    masterClient.onMessage(handler)

    return () => {
      // PipeClient doesn't support removeHandler, but cleanup on unmount
      // is handled by disconnect in /detach command
      streamBuffer = ''
    }
  }, [enabled, role, masterClient, onSubmitMessage])
}
