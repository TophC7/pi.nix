export function specNewPrompt(planPath: string): string {
	return `Run Pi /spec:new from plan draft: ${planPath}

/spec is durable commitment. Do not brainstorm from blank.

Mode rules:
- Read the selected plan draft and relevant repo files.
- Use ask_user for real durable decisions: spec name, shape, scope/out-of-scope, risky behavior changes, acceptance gates.
- Generate phased, ticketed, or light spec files under .sworm/spec/<name>/.
- Include Current State markers in todo.md for phased/ticketed or SPEC.md for light.
- Include frontmatter recording AskClaude hardening or waiver.
- Immediately before durable save, call isolated AskClaude to harden the complete spec.
- If AskClaude fails, use ask_user recovery gate: retry, model/config adjustment, manual Claude prompt, waiver, or abort.
- Save spec files only with save_spec.
- Use trekker tool to create one SPEC epic and one TASK top-level task per §T row. Mirror dependencies with trekker dep add.
- Round-trip Trekker IDs into §T tables before final save.
- Mark the plan frontmatter promoted_to and promoted_at by re-saving it with save_plan_draft.

Required shape files:
- phased: .sworm/spec/<name>/todo.md + phase-*.md
- ticketed: .sworm/spec/<name>/todo.md + ticket-*.md
- light: .sworm/spec/<name>/SPEC.md`;
}

export function planPrompt(description: string): string {
	return `Run Pi /plan for: ${description || "user-selected topic"}

/plan is draft exploration. /spec is durable commitment.

Mode rules:
- Inspect repo with read/search/list and safe fish commands only.
- Do not edit implementation files and do not create Trekker state.
- Ask user only for real decisions.
- Produce plan markdown with frontmatter and sections required by pi-spec-workflow.
- Immediately before save, call isolated AskClaude for final hardening. Ask it to verify claims, risks, missing files, decisions, and promotion readiness.
- If AskClaude fails, use ask_user recovery gate: retry, model/config adjustment, manual Claude prompt, waiver, or abort.
- Save only with save_plan_draft to .sworm/plans/YYYY-MM-DD-<slug>.md.
- After saving, ask_user: promote now, keep draft only, or revise.

Required frontmatter:
---
title: <title>
created: 2026-05-04
status: draft
hardened_by: AskClaude
hardened_status: passed
hardened_at: 2026-05-04
waiver_reason:
promoted_to:
promoted_at:
---

Required sections: Goal, Findings, Options considered, Recommended approach, Risks, Open questions resolved, Critical files, Promotion notes.`;
}
