import type { LocalCommandCall } from '../../types/command.js'
import { connectToPipe, type PipeClient, type PipeMessage } from '../../utils/pipeTransport.js'
import { addSlaveClient } from '../../hooks/useMasterMonitor.js'

export const call: LocalCommandCall = async (args, context) => {
  const targetName = args.trim()
  if (!targetName) {
    return {
      type: 'text',
      value: 'Usage: /attach <pipe-name>\nUse /pipes to list available pipes.',
    }
  }

  const currentState = context.getAppState()

  // Check if already attached to this slave
  if (currentState.pipeIpc.slaves[targetName]) {
    return {
      type: 'text',
      value: `Already attached to "${targetName}".`,
    }
  }

  // Cannot attach when in slave mode
  if (currentState.pipeIpc.role === 'slave') {
    return {
      type: 'text',
      value: 'Cannot attach: this CLI is in slave mode. Use /detach from the master first.',
    }
  }

  // Connect to the target pipe server
  let client: PipeClient
  try {
    const myName = currentState.pipeIpc.serverName ?? `master-${process.pid}`
    client = await connectToPipe(targetName, myName)
  } catch (err) {
    return {
      type: 'text',
      value: `Failed to connect to "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Send attach request and wait for response
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.disconnect()
      resolve({
        type: 'text',
        value: `Attach to "${targetName}" timed out (no response within 5s).`,
      })
    }, 5000)

    client.onMessage((msg: PipeMessage) => {
      if (msg.type === 'attach_accept') {
        clearTimeout(timeout)

        // Register the slave client in the module-level registry
        addSlaveClient(targetName, client)

        // Update AppState: add slave and switch to master role
        context.setAppState((prev) => ({
          ...prev,
          pipeIpc: {
            ...prev.pipeIpc,
            role: 'master',
            slaves: {
              ...prev.pipeIpc.slaves,
              [targetName]: {
                name: targetName,
                connectedAt: new Date().toISOString(),
                status: 'idle' as const,
                history: [],
              },
            },
          },
        }))

        const slaveCount = Object.keys(currentState.pipeIpc.slaves).length + 1
        resolve({
          type: 'text',
          value: `Attached to "${targetName}" as master. Now monitoring ${slaveCount} slave(s).\nUse /send ${targetName} <message> to send tasks.\nUse /status to see all slaves.\nUse /detach ${targetName} to disconnect.`,
        })
      } else if (msg.type === 'attach_reject') {
        clearTimeout(timeout)
        client.disconnect()

        resolve({
          type: 'text',
          value: `Attach rejected by "${targetName}": ${msg.data ?? 'unknown reason'}`,
        })
      }
    })

    client.send({ type: 'attach_request' })
  })
}
