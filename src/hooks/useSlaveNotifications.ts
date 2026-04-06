/**
 * useSlaveNotifications — Real-time toast notifications for slave CLI events
 *
 * When role === 'master', watches slave session history for key events
 * and shows toast notifications in the master CLI's footer:
 *
 * - Slave turn complete (done) → "[slave-name] 完成: <last stream content>"
 * - Slave error → "[slave-name] 错误: <error message>"
 * - Slave tool execution → "[slave-name] 工具: <tool name>"
 * - Slave busy (prompt received) → "[slave-name] 开始处理任务"
 */

import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppState.js'
import { useNotifications } from '../context/notifications.js'
import type { Notification } from '../context/notifications.js'
import type { SessionEntry } from './useMasterMonitor.js'
import { getPipeIpc } from '../utils/pipeTransport.js'

/**
 * Fold function: merge consecutive notifications from the same slave
 * into a single count-based notification.
 */
function foldSlaveNotif(
  acc: Notification,
  _incoming: Notification,
): Notification {
  if (!('text' in acc)) return acc
  const match = acc.text.match(/\((\d+)\)$/)
  const count = match ? parseInt(match[1], 10) + 1 : 2
  // Replace trailing count or append it
  const base = acc.text.replace(/\s*\(\d+\)$/, '')
  return {
    ...acc,
    text: `${base} (${count})`,
    fold: foldSlaveNotif,
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

export function useSlaveNotifications(): void {
  const role = useAppState((s) => getPipeIpc(s).role)
  const slaves = useAppState((s) => getPipeIpc(s).slaves)
  const { addNotification } = useNotifications()

  // Track last seen history length per slave to detect new entries
  const lastSeenRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (role !== 'master') return

    for (const [name, slave] of Object.entries(slaves)) {
      const lastSeen = lastSeenRef.current[name] ?? 0
      const newEntries = slave.history.slice(lastSeen)
      lastSeenRef.current[name] = slave.history.length

      for (const entry of newEntries) {
        const notif = makeNotification(name, entry)
        if (notif) {
          addNotification(notif)
        }
      }
    }

    // Clean up removed slaves
    for (const name of Object.keys(lastSeenRef.current)) {
      if (!(name in slaves)) {
        delete lastSeenRef.current[name]
      }
    }
  }, [role, slaves, addNotification])
}

function makeNotification(
  slaveName: string,
  entry: SessionEntry,
): Notification | null {
  const short = slaveName.length > 16 ? slaveName.slice(0, 16) + '…' : slaveName

  switch (entry.type) {
    case 'done':
      return {
        key: `slave-done-${slaveName}`,
        text: `[${short}] ✓ 任务完成`,
        priority: 'medium',
        timeoutMs: 5000,
        fold: foldSlaveNotif,
      }

    case 'error':
      return {
        key: `slave-error-${slaveName}`,
        text: `[${short}] ✗ 错误: ${truncate(entry.content, 60)}`,
        color: 'error',
        priority: 'high',
        timeoutMs: 8000,
      }

    case 'tool_start':
      return {
        key: `slave-tool-${slaveName}`,
        text: `[${short}] 工具: ${truncate(entry.content, 40)}`,
        priority: 'low',
        timeoutMs: 3000,
        fold: foldSlaveNotif,
      }

    case 'prompt':
      return {
        key: `slave-prompt-${slaveName}`,
        text: `[${short}] ▶ 开始处理: ${truncate(entry.content, 50)}`,
        priority: 'medium',
        timeoutMs: 4000,
      }

    // stream and tool_result are too frequent — skip to avoid noise
    case 'stream':
    case 'tool_result':
    default:
      return null
  }
}
