import type { Command } from '../../commands.js'

const history = {
  type: 'local',
  name: 'history',
  description: 'View session transcript of a connected slave CLI',
  argumentHint: '<pipe-name> [--last N]',
  supportsNonInteractive: false,
  load: () => import('./history.js'),
} satisfies Command

export default history
