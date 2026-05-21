// ## CHECK ## //
// User-initiated verification of the active spec. Agent-driven: the command
// acquires a turn-spanning lock and posts an instructional follow-up prompt.
// The agent dispatches scout subagents, integrates findings, asks_user per
// real ambiguity, and writes the spec back with a Verification section plus
// status: verified.

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { resolveOrPick } from './active-spec.ts'
import { readSpec, SPEC_ROOT, specPath } from './files.ts'
import { CHECK_TOOLS, startOperation } from './lock.ts'

export async function runCheck(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const slug = await resolveOrPick(pi, ctx, args)
  if (!slug) {
    ctx.ui.notify('/spec:check: no active spec.', 'warning')
    return
  }
  const spec = readSpec(ctx.cwd, slug)
  if (!spec) {
    ctx.ui.notify(`/spec:check: spec ${slug} not found under ${SPEC_ROOT}.`, 'error')
    return
  }
  if (!spec.goal.trim()) {
    ctx.ui.notify(`/spec:check: ${slug} has no goal. Fill ## Goal before verifying.`, 'warning')
    return
  }
  if (spec.tasks.length === 0) {
    ctx.ui.notify(
      `/spec:check: ${slug} has no canonical tasks. Add ### task blocks with <!-- sworm: slug=... --> and **Acceptance:** before verifying.`,
      'warning'
    )
    return
  }
  try {
    startOperation(pi, 'spec:check', CHECK_TOOLS)
  } catch (error) {
    ctx.ui.notify(`/spec:check cannot start: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  const path = specPath(ctx.cwd, slug)
  pi.sendUserMessage(buildCheckPrompt(slug, path), { deliverAs: 'followUp' })
  ctx.ui.notify(`/spec:check: handing off ${slug} to agent for verification.`, 'info')
}

function buildCheckPrompt(slug: string, path: string): string {
  // CLAUDE: Do NOT lead this prompt with slash-command-shaped text (e.g.
  // `/spec:check ...`). Pi's command parser will hijack the first token and
  // corrupt the prompt body. Lead with prose.
  return `Verification phase for spec ${slug}.

Spec file: ${path}

Run the verification phase now. Stay inside this turn until you've updated the spec.

Steps:
1. Read the spec file at ${path}.
2. Identify the load-bearing claims that depend on repository facts (file paths, APIs, behaviors, conventions, prereqs). Treat the spec's tasks and acceptance lines as the source of claims to check.
3. Dispatch one or more sdd.scout subagents in parallel via the subagent tool. Each scout gets ONE narrow assignment. Use the request shape:
   { tasks: [ { agent: 'sdd.scout', task: '<one specific claim to verify, with enough context to act>' }, ... ], context: 'fresh', agentScope: 'both' }
4. Integrate findings into a single report with three sections: Confirmed, Issues, Questions.
5. For each real ambiguity, call the ask_user tool with one focused question. Practical language: class names and module references are fine, but skip line numbers. Each ask_user question must carry a recommended option with reasoning plus one or two alternatives.
6. After collecting answers, update the spec file:
   - Resolve ambiguities into the task descriptions or acceptance lines.
   - Append (or replace) a top-level "## Verification" section recording: the date, decisions made (with the alternatives considered), and what was confirmed against the repo.
   - Update frontmatter: status: verified, verified_at: <today's date YYYY-MM-DD>.
7. Save with the write tool.
8. End your turn with a one-paragraph summary of what was verified, what was decided, and what changed in the spec.

Do not edit any files outside ${path}. Do not call sworm_* tools.`
}
