/**
 * useMasterMonitor — Master-side monitoring hook
 *
 * When role === 'master', this hook listens to all connected slave PipeClients
 * and stores their session data (stream, tool events, done, error) into
 * AppState.pipeIpc.slaves[name].history.
 *
 * The master CLI itself remains fully functional — this hook only collects
 * data from slaves for review via /history and /status commands.
 */

import { useEffect } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { getPipeIpc, type PipeClient, type PipeMessage } from '../utils/pipeTransport.js'
import { logForDebugging } from '../utils/debug.js'

/** Session history entry for pipe IPC monitoring. */
export type SessionEntry = {
  type: string
  content: string
  from: string
  timestamp: string
  meta?: Record<string, unknown>
}

/**
 * Module-level registry of connected slave PipeClients.
 * Keyed by slave pipe name. Managed by /attach and /detach commands.
 */
const _slaveClients = new Map<string, PipeClient>()

export function addSlaveClient(name: string, client: PipeClient): void {
  _slaveClients.set(name, client)
}

export function removeSlaveClient(name: string): PipeClient | undefined {
  const client = _slaveClients.get(name)
  _slaveClients.delete(name)
  return client
}

export function getSlaveClient(name: string): PipeClient | undefined {
  return _slaveClients.get(name)
}

export function getAllSlaveClients(): Map<string, PipeClient> {
  return _slaveClients
}

export function useMasterMonitor(): void {
  const role = useAppState((s) => getPipeIpc(s).role)
  const setAppState = useSetAppState()

  useEffect(() => {
    if (role !== 'master') return

    // Set up listeners for each connected slave client
    const cleanups: (() => void)[] = []

    for (const [slaveName, client] of _slaveClients.entries()) {
      const handler = (msg: PipeMessage) => {
        const entry: SessionEntry = {
          type: msg.type as SessionEntry['type'],
          content: msg.data ?? '',
          from: msg.from ?? slaveName,
          timestamp: msg.ts ?? new Date().toISOString(),
          meta: msg.meta,
        }

        // Only record relevant message types
        if (!['stream', 'tool_start', 'tool_result', 'done', 'error', 'prompt'].includes(msg.type)) {
          return
        }

        setAppState((prev) => {
          const slave = getPipeIpc(prev).slaves[slaveName]
          if (!slave) return prev

          const newStatus =
            msg.type === 'done' || msg.type === 'error' ? 'idle' :
            msg.type === 'prompt' ? 'busy' : slave.status

          return {
            ...prev,
            pipeIpc: {
              ...getPipeIpc(prev),
              slaves: {
                ...getPipeIpc(prev).slaves,
                [slaveName]: {
                  ...slave,
                  status: newStatus,
                  history: [...slave.history, entry],
                },
              },
            },
          }
        })

        if (msg.type === 'done') {
          logForDebugging(`[MasterMonitor] Slave "${slaveName}" turn complete`)
        }
      }

      client.onMessage(handler)

      // Handle slave disconnect
      const onDisconnect = () => {
        logForDebugging(`[MasterMonitor] Slave "${slaveName}" disconnected`)
        _slaveClients.delete(slaveName)
        setAppState((prev) => {
          const { [slaveName]: _removed, ...remainingSlaves } = getPipeIpc(prev).slaves
          const hasSlaves = Object.keys(remainingSlaves).length > 0
          return {
            ...prev,
            pipeIpc: {
              ...getPipeIpc(prev),
              role: hasSlaves ? 'master' : 'standalone',
              slaves: remainingSlaves,
            },
          }
        })
      }

      client.on('disconnect', onDisconnect)
      cleanups.push(() => {
        client.removeListener('disconnect', onDisconnect)
      })
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
  }, [role, setAppState])
}
