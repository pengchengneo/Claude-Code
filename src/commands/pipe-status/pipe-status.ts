import type { LocalCommandCall } from '../../types/command.js'
import { getAllSlaveClients } from '../../hooks/useMasterMonitor.js'
import { getPipeIpc } from '../../utils/pipeTransport.js'

export const call: LocalCommandCall = async (_args, context) => {
  const currentState = context.getAppState()

  if (getPipeIpc(currentState).role === 'standalone') {
    return {
      type: 'text',
      value: 'Standalone mode — not connected to any CLIs.\nUse /attach <pipe-name> to connect to a slave.',
    }
  }

  if (getPipeIpc(currentState).role === 'slave') {
    return {
      type: 'text',
      value: `Slave mode — controlled by "${getPipeIpc(currentState).attachedBy}".\nAll session data is being reported to the master.`,
    }
  }

  // Master mode
  const slaves = getPipeIpc(currentState).slaves
  const slaveNames = Object.keys(slaves)
  const clients = getAllSlaveClients()

  if (slaveNames.length === 0) {
    return {
      type: 'text',
      value: 'Master mode but no slaves connected.\nUse /attach <pipe-name> to connect.',
    }
  }

  const lines: string[] = [
    `Master mode — ${slaveNames.length} slave(s) connected:`,
    '',
  ]

  for (const name of slaveNames) {
    const slave = slaves[name]!
    const client = clients.get(name)
    const connected = client?.connected ? 'connected' : 'disconnected'
    const historyCount = slave.history.length
    const connectedAt = slave.connectedAt.slice(11, 19)

    lines.push(`  ${name}`)
    lines.push(`    Status:    ${slave.status} (${connected})`)
    lines.push(`    Connected: ${connectedAt}`)
    lines.push(`    History:   ${historyCount} entries`)
    lines.push('')
  }

  lines.push('Commands:')
  lines.push('  /send <name> <msg>  — Send a task to a slave')
  lines.push('  /history <name>     — View slave session transcript')
  lines.push('  /detach [name]      — Disconnect from a slave (or all)')

  return { type: 'text', value: lines.join('\n') }
}
