import type { Command } from '../../commands.js'

const pipes = {
  type: 'local',
  name: 'pipes',
  description: 'List available named pipes for terminal-to-terminal communication',
  supportsNonInteractive: false,
  load: () => import('./pipes.js'),
} satisfies Command

export default pipes
