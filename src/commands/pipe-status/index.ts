import type { Command } from '../../commands.js'

const pipeStatus = {
  type: 'local',
  name: 'pipe-status',
  description: 'Show status of all connected slave CLIs',
  supportsNonInteractive: false,
  load: () => import('./pipe-status.js'),
} satisfies Command

export default pipeStatus
