// ## SDD ## //
// Spec-driven development. Markdown for intent, Sworm for state, one operation
// lock per durable verb. No authoring mode, no handoff state machine. See the
// adjacent modules for the moving parts.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { defineExtension } from '@pi/lib'
import { installLockInterceptor } from '@pi/lib/lock'
import { getActiveSpec } from './active-spec.ts'
import { registerSddCommands } from './commands.ts'
import { SPEC_ROOT } from './files.ts'
import { installDraftBlock } from './lock.ts'

export default defineExtension({
  name: 'sdd',
  setup: (pi: ExtensionAPI) => {
    installLockInterceptor(pi)
    installDraftBlock(pi)
    registerSddCommands(pi)
    pi.on('before_agent_start', (event) => maybeAppendActiveSpec(event))
  }
})

interface AgentStartEvent {
  systemPrompt: string
}

function maybeAppendActiveSpec(event: AgentStartEvent): { systemPrompt: string } | undefined {
  const slug = getActiveSpec()
  if (!slug) return undefined
  return {
    systemPrompt:
      event.systemPrompt +
      `\n\nActive sdd spec: ${slug} (${SPEC_ROOT}/${slug}.md).\n` +
      `This is the working spec for this conversation. Read it when editing or discussing.\n` +
      `Reach for the sdd commands (/spec, /spec:check, /spec:ship, /spec:work) for spec-scoped actions.`
  }
}
