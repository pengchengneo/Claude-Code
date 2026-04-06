import type { Command } from '../../commands.js'

const detach = {
  type: 'local',
  name: 'detach',
  description: 'Detach from a slave CLI (or all slaves if no name given)',
  argumentHint: '[pipe-name]',
  supportsNonInteractive: false,
  load: () => import('./detach.js'),
} satisfies Command

export default detach
