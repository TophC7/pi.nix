// ## PROMPT ## //
// Shared sdd guidance injected into active-spec follow-ups and turn-start
// system prompts. Keep this explicit: draft specs are editable prose, but the
// required Goal/Tasks schema must survive every conversation-driven edit.

import type { SpecStatus } from './parser.ts'

export interface ActiveSpecPromptOptions {
  slug: string
  path: string
  status: SpecStatus
  surface: 'followUp' | 'system'
}

export function buildActiveSpecPrompt(options: ActiveSpecPromptOptions): string {
  const intro =
    options.surface === 'followUp'
      ? `Active sdd spec is now ${options.slug} (status: ${options.status}).`
      : `Active sdd spec: ${options.slug} (status: ${options.status}).`
  const body = buildActiveSpecBody(options.status, options.surface)
  return `${intro}\nSpec file: ${options.path}\n\n${body}`
}

function buildActiveSpecBody(status: SpecStatus, surface: ActiveSpecPromptOptions['surface']): string {
  if (surface === 'system') {
    return status === 'draft' ? DRAFT_SPEC_REMINDER : NON_DRAFT_SPEC_REMINDER
  }
  return status === 'draft' ? DRAFT_SPEC_CONTRACT : NON_DRAFT_SPEC_CONTRACT
}

const NON_DRAFT_SPEC_REMINDER = `Read active spec before spec-scoped edits. Use /spec:ship or /spec:work for lifecycle actions. Do not hand-edit lifecycle status or ids.`

const DRAFT_SPEC_REMINDER = `Draft spec active. Read it before editing. Preserve frontmatter, ## Goal, and canonical ## Tasks blocks (### title, <!-- sworm: slug=... -->, **Acceptance:**). Put notes/questions in extra sections. Do not hand-set lifecycle status or ids.`

const NON_DRAFT_SPEC_CONTRACT = `Read the spec for context before editing or working.
Use the spec commands for lifecycle transitions: /spec:check verifies draft intent against the repo, /spec:ship materializes Sworm tasks, and /spec:work executes shipped tasks.
Do not casually rewrite shipped/verified intent; reopen discussion in the spec first if scope changes.`

const DRAFT_SPEC_CONTRACT = `Draft spec mode contract:
- Read the spec before editing it. Preserve existing valid structure.
- Required sections: frontmatter with title/status, top-level ## Goal, top-level ## Tasks.
- ## Goal must state the outcome and boundaries clearly enough for later verification.
- ## Tasks must contain canonical task blocks. Bullet-list tasks are notes, not shippable tasks.
- If ## Goal is empty, draft it from the conversation or ask one focused question. If ## Tasks is empty and scope is concrete enough, add canonical task blocks; otherwise add ## Open questions instead of inventing tasks.
- Canonical task block format:

### <task title>
<!-- sworm: slug=<kebab-case>; deps=<optional-slug,other-slug> -->
**Acceptance:** \`<runnable command>\` OR <manual observable condition>

<short implementation description, constraints, and relevant paths>

- Each task needs title, sworm slug, acceptance line, and description. deps is optional and references task slugs.
- Extra useful information is welcome, but put it in extra top-level sections such as ## Decisions, ## Open questions, ## Scout findings, or ## Notes. Extras never replace ## Goal or canonical ## Tasks.
- Keep status: draft while discussing. Do not set verified_at, epic_id, issue ids, or status: verified/shipped by hand; /spec:check and /spec:ship own those transitions.
- If requirements are ambiguous, ask the user or record a focused ## Open questions item. Do not invent decisions just to fill the spec.
- Before every spec edit, check that ## Goal still exists and every task under ## Tasks is a canonical task block. If not, repair the schema as part of the edit.
- While draft is active, writes outside .sworm/sdd/ are blocked unless the user runs /spec:freehand or closes the spec.`
