import type { LocalCommandCall } from '../../types/command.js'
import { listPipes, isPipeAlive, getPipeIpc } from '../../utils/pipeTransport.js'

export const call: LocalCommandCall = async (_args, context) => {
  const currentState = context.getAppState()
  const myName = getPipeIpc(currentState).serverName
  const role = getPipeIpc(currentState).role

  const allPipes = await listPipes()

  const lines: string[] = []

  // Show own pipe name and status
  lines.push(`Your pipe:  ${myName ?? '(not started)'}`)
  lines.push(`Role:       ${role}`)

  if (role === 'master') {
    const slaveNames = Object.keys(getPipeIpc(currentState).slaves)
    lines.push(`Slaves (${slaveNames.length}): ${slaveNames.join(', ') || 'none'}`)
  } else if (role === 'slave') {
    lines.push(`Controlled by: ${getPipeIpc(currentState).attachedBy}`)
  }

  lines.push('')

  // List other pipes with liveness check
  const otherPipes = allPipes.filter((p) => p !== myName)
  if (otherPipes.length === 0) {
    lines.push('No other pipes found.')
  } else {
    lines.push(`Other pipes (${otherPipes.length}):`)
    for (const name of otherPipes) {
      const alive = await isPipeAlive(name)
      const status = alive ? 'alive' : 'stale'
      const isAttached = getPipeIpc(currentState).slaves[name] ? ' [attached]' : ''
      lines.push(`  ${name}  [${status}]${isAttached}`)
    }
  }

  lines.push('')
  lines.push('To attach: /attach <pipe-name>')
  lines.push('To send:   /send <pipe-name> <message>')

  return { type: 'text', value: lines.join('\n') }
}
