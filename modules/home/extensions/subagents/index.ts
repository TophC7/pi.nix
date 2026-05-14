import { defineExtension } from '@pi/lib'
import { registerSubagentTool, shouldRegisterLocalSubagentTool } from '@pi/lib/subagents'

export default defineExtension({
  name: 'subagents',
  setup: (pi) => {
    pi.on('session_start', () => {
      // Safe cutover guard: register local tool only when no active tool named
      // `subagent` exists, preserving exactly one model-facing owner.
      if (shouldRegisterLocalSubagentTool(pi)) registerSubagentTool(pi)
    })
  }
})
