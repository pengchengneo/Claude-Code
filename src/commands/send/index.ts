import type { Command } from '../../commands.js'

const send = {
  type: 'local',
  name: 'send',
  description: 'Send a prompt/task to a connected slave CLI',
  argumentHint: '<pipe-name> <message>',
  supportsNonInteractive: false,
  load: () => import('./send.js'),
} satisfies Command

export default send
