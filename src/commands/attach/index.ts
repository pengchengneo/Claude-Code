import type { Command } from '../../commands.js'

const attach = {
  type: 'local',
  name: 'attach',
  description: 'Attach to a slave CLI to monitor and control it',
  argumentHint: '<pipe-name>',
  supportsNonInteractive: false,
  load: () => import('./attach.js'),
} satisfies Command

export default attach
