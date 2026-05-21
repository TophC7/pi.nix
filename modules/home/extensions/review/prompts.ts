import { REVIEW_CARD_SCHEMA_PROMPT, type ReviewScope } from './schema.ts'

export interface ReviewScoutTaskArgs {
  scope: ReviewScope
  context: string
  targetLabel: string
  targetRules: string
}

export function reviewScoutTask(args: ReviewScoutTaskArgs): string {
  return `Run the /review ${args.scope} scout.

Review target: ${args.targetLabel}

Target rules:
${args.targetRules}

Read the review context first, then inspect only repository files needed to verify findings for this scope.

Rules:
- Read-only. Do not edit, write, stage, commit, push, or create files.
- Stay inside your scope: ${args.scope}.
- Cite concrete file paths and line ranges for every finding.
- Skip findings you cannot anchor to the requested review target or directly relevant context.
- Return evidence-backed findings only. Do not speculate.
- Do not use markdown pipe tables.

${REVIEW_CARD_SCHEMA_PROMPT}

Review context:
~~~~markdown
${args.context}
~~~~
`
}

export function reviewReportPrompt(report: string): string {
  // Do not begin with slash-command-shaped text. Pi command parsing can hijack
  // leading slash tokens in follow-up prompts.
  return `Review triage phase.

Use the synthesized review below as source of truth. Do not re-review. Inspect files only when needed to apply chosen fixes safely.

Your job is to translate findings into useful next-step decisions, then immediately fix the items the user chooses. Do not ask for a second confirmation after the interview.

Steps:
1. Show the practical findings rundown below. Keep it readable: no long card headers, no markdown link clutter. Include the concrete repair direction for each finding.
2. Ask the user one focused ask_user question per actionable finding, in report order. Required/Blocking findings come first, Suggestions after. If there are no findings, ask nothing and finish with the summary.
3. Shape each ask_user call like /spec:check:
   - Context field: short practical explanation with where, failure mode, impact, evidence, and why the recommended path fits. Class names and module references are fine; skip line-number noise.
   - Question: ask which concrete repair path should be taken next, not whether the finding should be accepted.
   - Options: finding-specific choices with descriptions. First option is usually the recommended fix and says why. Include one or two real alternatives when useful. Avoid generic labels like "Apply recommended fix", "Defer", or "Discuss alternative".
   - Suggestions: make optionality explicit. Recommend doing small/high-signal improvements; recommend leaving broad or low-value polish alone.
4. After all answers, immediately apply the chosen repair paths in the same turn. Apply only selected fixes. Skip deferred items and unresolved alternatives. Keep edits scoped to reviewed findings unless a tiny adjacent change is required for correctness.
5. Validate with the narrowest useful check available. Do not stage, commit, push, or create Sworm state.
6. End with a compact summary: fixes applied, items deferred or intentionally skipped, validation run, and any remaining risk.

Synthesized review:
${report}`
}
