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
  return `Review decision phase.

Use the synthesized review below as source of truth. Do not re-review, inspect files, edit files, or call any tool except ask_user.

Steps:
1. Show the practical findings rundown below. Keep it readable: no long card headers, no markdown link clutter.
2. Ask the user one focused ask_user question per finding, in report order. Required/Blocking findings come first, Suggestions after.
3. Each ask_user question must include:
   - short context: problem, impact, recommended fix
   - options: "Apply recommended fix", "Defer", "Discuss alternative"
   - recommendation: usually "Apply recommended fix" for Blocking/Required; use judgment for Suggestions.
4. After all answers, end with a compact decision summary: approved fixes, deferred items, and open alternatives. Do not edit files in this turn.

Synthesized review:
${report}`
}
