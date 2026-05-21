// ## AGENTIC QA ## //
// Manual localhost website QA for Pi. Commands collect focused missions or prompts,
// then qa_report normalizes evidence-backed results and writes safe local artifacts.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { defineExtension } from '@pi/lib'
import { registerQaCommands } from './commands.ts'
import { registerQaTools } from './tools.ts'

export default defineExtension({
  name: 'agentic-qa',
  setup: (pi: ExtensionAPI) => {
    registerQaCommands(pi)
    registerQaTools(pi)
  }
})
