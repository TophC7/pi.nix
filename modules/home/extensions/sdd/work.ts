// ## WORK ## //
// Autonomous loop for the active spec's epic. Agent-driven: command acquires
// the role lock and posts an instructional prompt. Agent claims the next
// ready issue, implements, verifies via the acceptance gate, marks complete,
// loops. Hits a hard blocker → comments, marks blocked, moves to next.
// Stops when no more ready or user interrupts.

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { resolveOrPick } from './active-spec.ts'
import { readSpec, SPEC_ROOT, specPath } from './files.ts'
import { makeSpecPathBlock, startOperation, WORK_TOOLS } from './lock.ts'

export async function runWork(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const slug = await resolveOrPick(pi, ctx, args)
  if (!slug) {
    ctx.ui.notify('/spec:work: no active spec.', 'warning')
    return
  }
  const spec = readSpec(ctx.cwd, slug)
  if (!spec) {
    ctx.ui.notify(`/spec:work: spec ${slug} not found under ${SPEC_ROOT}.`, 'error')
    return
  }
  const epicId = spec.frontmatter.epicId?.trim()
  if (!epicId) {
    ctx.ui.notify(`/spec:work: ${slug} hasn't been shipped yet. Run /spec:ship first.`, 'warning')
    return
  }
  try {
    startOperation(pi, 'spec:work', WORK_TOOLS, {
      pathBlocks: [makeSpecPathBlock(`${SPEC_ROOT}/`)]
    })
  } catch (error) {
    ctx.ui.notify(`/spec:work cannot start: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  const path = specPath(ctx.cwd, slug)
  pi.sendUserMessage(buildWorkPrompt(slug, path, epicId), {
    deliverAs: 'followUp'
  })
  ctx.ui.notify(`/spec:work: handing off ${slug} (${epicId}) to agent for execution.`, 'info')
}

function buildWorkPrompt(slug: string, path: string, epicId: string): string {
  // IMPORTANT: Do NOT lead this prompt with slash-command-shaped text (e.g.
  // `/spec:work ...`). Pi's command parser will hijack the first token and
  // corrupt the prompt body. Lead with prose.
  return `Work loop for spec ${slug} (epic ${epicId}).

Spec file: ${path}

Run the autonomous loop now. Stay inside this turn until the loop ends.

Loop:
1. Call sworm_issue_ready with { epicId: '${epicId}' }. If empty, end the loop with a one-line "all ready issues complete" summary.
2. Take the first ready issue. Call sworm_issue_claim on it.
3. Call sworm_issue_show to read the full description. The acceptance line and dependency notes are inline in the description.
4. Implement the task. Read what you need from the repo, edit/write code, run tests via bash. Stay focused on this one issue.
5. Verify against the acceptance gate:
   - If "Acceptance (runnable): \`cmd\`" appears in the description, run \`cmd\` via bash. Pass means done.
   - If "Acceptance: <prose>" appears, self-judge against the prose. Be honest.
6. On done: call sworm_comment_add with a short summary of what changed and any tests run. Then sworm_issue_update with { status: 'completed' }. Loop to step 1.
7. On stuck: if you've made a real attempt and you're blocked by ambiguity, missing decisions, external prereqs, or repeated failures: call sworm_comment_add explaining the blocker. Then sworm_issue_update with { status: 'blocked' }. Loop to step 1 with the next ready issue.
8. End the loop and report in chat when ready returns empty, or when no remaining ready issue is workable, or when the user interrupts.

Hard rules:
- Do not edit anything under .sworm/sdd/. The spec is intent; you don't change intent while implementing it.
- Do not call sworm_issue_create, sworm_epic_*, or sworm_config_*. Use only the issue tools listed above.
- Do not ask_user mid-loop. If you need user input, stop, comment the blocker on the issue, set blocked, and end the turn so the user can respond in chat.
- Report progress in your assistant text between iterations so the user can follow along.`
}
