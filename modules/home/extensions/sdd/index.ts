// ## SDD ## //
// Spec-driven development. Markdown for intent, Sworm for state, one operation
// lock per durable verb. No authoring mode, no handoff state machine. See the
// adjacent modules for the moving parts.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { defineExtension } from '@pi/lib'
import { installLockInterceptor } from '@pi/lib/lock'
import { getActiveCwd, getActiveSpec } from './active-spec.ts'
import { registerSddCommands } from './commands.ts'
import { readSpec, SPEC_ROOT, specPath } from './files.ts'
import { installDraftBlock } from './lock.ts'
import { buildActiveSpecPrompt } from './prompt.ts'

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
    systemPrompt: event.systemPrompt + `\n\n${buildTurnStartPrompt(slug)}`
  }
}

function buildTurnStartPrompt(slug: string): string {
  const cwd = getActiveCwd()
  if (cwd) {
    try {
      const spec = readSpec(cwd, slug)
      if (spec) {
        return buildActiveSpecPrompt({
          slug,
          path: specPath(cwd, slug),
          status: spec.frontmatter.status,
          surface: 'system'
        })
      }
    } catch {
      // Fall through to conservative generic guidance.
    }
  }
  return (
    `Active sdd spec: ${slug} (${SPEC_ROOT}/${slug}.md).\n` +
    `Read it before editing or discussing. Preserve ## Goal and canonical ## Tasks task blocks.\n` +
    `Use /spec:check to verify, /spec:ship to materialize Sworm tasks, and /spec:work to execute shipped tasks.`
  )
}
