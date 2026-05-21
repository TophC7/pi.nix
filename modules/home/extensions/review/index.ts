import { defineExtension } from '@pi/lib'
import { installLockInterceptor } from '@pi/lib/lock'
import { registerReviewCommands } from './commands.ts'

export default defineExtension({
  name: 'review',
  setup: (pi) => {
    installLockInterceptor(pi)
    registerReviewCommands(pi)
  }
})
