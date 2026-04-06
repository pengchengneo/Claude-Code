import type { LocalCommandCall } from '../../types/command.js'
import { removeSlaveClient, getAllSlaveClients } from '../../hooks/useMasterMonitor.js'
import { getPipeIpc } from '../../utils/pipeTransport.js'

export const call: LocalCommandCall = async (args, context) => {
  const currentState = context.getAppState()

  if (getPipeIpc(currentState).role === 'standalone') {
    return { type: 'text', value: 'Not attached to any CLI.' }
  }

  if (getPipeIpc(currentState).role === 'slave') {
    return {
      type: 'text',
      value: 'This CLI is in slave mode. The master must detach.',
    }
  }

  // Master mode
  const targetName = args.trim()

  if (targetName) {
    // Detach from a specific slave
    const client = removeSlaveClient(targetName)
    if (!client) {
      return {
        type: 'text',
        value: `Not attached to "${targetName}". Use /status to see connected slaves.`,
      }
    }

    try {
      client.send({ type: 'detach' })
    } catch {
      // Socket may already be closed
    }
    client.disconnect()

    // Remove slave from state
    context.setAppState((prev) => {
      const { [targetName]: _removed, ...remainingSlaves } = getPipeIpc(prev).slaves
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

    return {
      type: 'text',
      value: `Detached from "${targetName}".`,
    }
  }

  // No target specified — detach from ALL slaves
  const allClients = getAllSlaveClients()
  const slaveNames = Array.from(allClients.keys())

  for (const name of slaveNames) {
    const client = removeSlaveClient(name)
    if (client) {
      try {
        client.send({ type: 'detach' })
      } catch {
        // Ignore
      }
      client.disconnect()
    }
  }

  context.setAppState((prev) => ({
    ...prev,
    pipeIpc: {
      ...getPipeIpc(prev),
      role: 'standalone',
      slaves: {},
    },
  }))

  return {
    type: 'text',
    value: `Detached from ${slaveNames.length} slave(s): ${slaveNames.join(', ')}. Back to standalone mode.`,
  }
}
