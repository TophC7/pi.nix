// ## AGENTIC QA ## //
// Manual localhost website QA for Pi. Commands compile a QaRunSpec; the agent
// runs qa_plan -> Playwright -> qa_step -> qa_finish; Pi writes the deterministic
// report.json and report.md once safety gates pass.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { defineExtension } from '@pi/lib'
import { registerQaCommands } from './commands.ts'
import { registerQaModelRestoreLifecycle } from './model-restore.ts'
import { registerPlaywrightCapture } from './playwright-capture.ts'
import { registerQaTools } from './tools.ts'

export default defineExtension({
  name: 'agentic-qa',
  setup: (pi: ExtensionAPI) => {
    registerQaCommands(pi)
    registerQaTools(pi)
    registerPlaywrightCapture(pi)
    registerQaModelRestoreLifecycle(pi)
  }
})
