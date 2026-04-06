import type { Command } from '../../types/command.js'
import { isBuddyLive } from '../../buddy/useBuddyNotification.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: 'Hatch a coding companion \u00b7 pet, off',
  argumentHint: '[pet|off]',
  get isHidden() {
    return !isBuddyLive()
  },
  immediate: true,
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
