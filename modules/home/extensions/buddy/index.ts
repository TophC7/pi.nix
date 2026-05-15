import { defineExtension } from '@pi/lib'
import { buddyCommands } from './commands.ts'
import { registerBuddyEvents } from './events.ts'
import { registerBuddyTools } from './tools.ts'
import { publishBuddyWidgets } from './ui/index.ts'

export default defineExtension({
  name: 'buddy',
  setup: (pi) => {
    registerBuddyTools(pi)
    registerBuddyEvents(pi)
    publishBuddyWidgets()
  },
  commands: buddyCommands
})
