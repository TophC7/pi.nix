function localDate(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function planScoutTask(description: string): string {
  return `Explore repo for /plan idea hardening.

User idea:
${description}

Return concise findings only. Include:
- relevant files and why they matter;
- current behavior/architecture;
- constraints and invariants;
- likely implementation seams;
- facts that need user confirmation;
- 3-7 focused interview questions.

Rules:
- Read-only. Do not edit or write files.
- Use fish-compatible read-only shell commands only.
- Cite exact paths and line ranges where possible.`
}

export function planRiskScoutTask(description: string): string {
  return `Run independent risk/validation scout for /plan idea hardening.

User idea:
${description}

Focus on:
- hidden scope expansions;
- edge cases and regressions;
- tests/checks likely needed;
- migration/backward-compat risks;
- simpler alternative approaches;
- user decisions needed before drafting.

Rules:
- Read-only. Do not edit or write files.
- Use fish-compatible read-only shell commands only.
- Cite exact paths and line ranges where possible.`
}

export interface PlanFinalizeArgs {
  description: string
  findingsPath: string
}

export function planFinalizePrompt(args: PlanFinalizeArgs): string {
  const date = localDate()
  return `Finalize Pi /plan for: ${args.description}

Scouts already ran. You now own the interview, synthesis, hardening, and save.

Inputs (read this file once; do not re-derive):
- Subagent findings (spec.plan-scout + spec.plan-risk-scout): ${args.findingsPath}

Mode rules:
1. Do not edit implementation files. Do not create Sworm issue state.
2. Read the findings file. Pull out the interview questions and any "facts needing user confirmation" / "decisions needed".
3. Interview the user with the ask_user tool. One focused question per call. Skip questions the findings already answer. If the user defers a question, treat it as an unresolved Open Question, not a guess.
4. Call the subagent tool to run spec.plan-synthesizer with a task that includes:
   - the original idea (above);
   - the findings (paste the contents);
   - the interview answers you collected.
   The synthesizer returns an unsaved plan draft. Treat it as canonical; do not rewrite stylistically.
5. If the draft has a critical unsupported claim, ask_user once to resolve before continuing; otherwise harden in place.
6. Call isolated AskClaude to verify claims, risks, missing files, decisions, and promotion readiness.
7. If AskClaude fails, ask_user for a recovery choice: retry, model/config adjustment, manual Claude prompt, waiver, or abort.
8. Save with save_plan_draft to .sworm/plans/${date}-<slug>.md.
9. After saving, ask_user: promote now, keep draft only, or revise.
   - On "promote now": call the promote_plan tool with the path returned by save_plan_draft. That tool hands the plan off to /spec:new and exits plan-authoring mode. Do not attempt Sworm writes from this mode; /spec:new allows Sworm writes only after final approval through approve_spec_finalization.
   - On "keep draft only": stop. Tell the user the saved path and that they can promote later with \`/plan promote\` or \`/spec:new <path>\`.
   - On "revise": ask what to change, update with save_plan_draft, then re-ask this question.

Required frontmatter:
---
title: <title>
created: ${date}
status: draft
hardened_by: AskClaude
hardened_status: passed
hardened_at: ${date}
waiver_reason:
promoted_to:
promoted_at:
---

Required sections: Goal, Findings, Options considered, Recommended approach, Risks, Open questions resolved, Critical files, Promotion notes.`
}

export interface ReviewFinalizeArgs {
  target: string
  reportPath: string
  planDraftPath: string
}

export function reviewFinalizePrompt(args: ReviewFinalizeArgs): string {
  const date = localDate()
  return `Finalize /plan:review for: ${args.target}

Review agents and synthesis already ran. You now own hardening, save, and optional promotion.

Inputs (read these files once; do not re-run review unless user asks):
- Review report: ${args.reportPath}
- Plan-compatible draft: ${args.planDraftPath}

Mode rules:
1. Do not edit implementation files. Do not create Sworm issue state.
2. Read both inputs.
3. If the report has no findings, ask_user before saving. Empty review plans are opt-in only.
4. Call isolated AskClaude to harden the review plan: verify schema, severity, evidence, duplicate merge, promotion mapping, and missing context.
5. If AskClaude fails, ask_user for a recovery choice: retry, model/config adjustment, manual Claude prompt, waiver, or abort.
6. Save with save_plan_draft to .sworm/plans/${date}-<slug>.md only after AskClaude pass or explicit waiver metadata is present.
7. After saving, ask_user: promote now, keep draft only, or revise.
   - On "promote now": call promote_plan with the saved path. Do not create Sworm state here; /spec:new gates Sworm writes behind final approval and approve_spec_finalization.
   - On "keep draft only": stop and report saved path.
   - On "revise": update the draft, re-harden if material, save again, then re-ask.

Required review-plan frontmatter before save:
---
title: <title>
created: ${date}
status: draft
review_plan: true
hardened_by: <AskClaude | waiver>
hardened_status: <passed | waived>
hardened_at: <${date} when AskClaude passed, blank or ${date} when waived>
waiver_reason: <blank for AskClaude pass; required non-empty text for waiver>
promoted_to:
promoted_at:
---

Accepted hardening metadata shapes:
- AskClaude pass: \`hardened_by: AskClaude\`, \`hardened_status: passed\`, \`hardened_at: ${date}\`, blank \`waiver_reason\`.
- Explicit waiver: \`hardened_by: waiver\`, \`hardened_status: waived\`, non-empty \`waiver_reason\`.

Required sections: Goal, Review findings, Required work, Suggestions, Promotion notes.
Review cards must keep severity in {Blocking, Required, Suggestion}, valid scope names, location, Problem, Evidence, Fix direction, and Spec promotion note. Suggestions must remain Advisory unless explicit opt-in metadata promotes them.`
}

export function specVerifierTask(planPath: string): string {
  return `Verify plan draft before /spec:new.

Plan path: ${planPath}

Read the plan and inspect relevant repo files. If frontmatter contains \`review_plan: true\`, also verify review-card mapping: Blocking/Required findings become required spec work; Suggestions stay advisory unless explicit opt-in metadata promotes them.

Return:
- plan assumptions with evidence or gaps;
- recommended spec shape: light, phased, or ticketed, with rationale;
- likely task boundaries and dependencies;
- acceptance/validation gates;
- review-plan mapping notes when applicable;
- risky durable decisions before Sworm issue creation;
- questions the user must answer before spec authoring.

Rules:
- Read-only. Do not edit or write files.
- Do not create Sworm state.
- Use fish-compatible read-only shell commands only.
- Cite exact paths and line ranges where possible.`
}

export interface SpecFinalizeArgs {
  planPath: string
  verificationPath: string
}

export function specFinalizePrompt(args: SpecFinalizeArgs): string {
  return `Finalize Pi /spec:new from plan draft: ${args.planPath}

Verifier already ran. You now own the interview, architect/review subagent dispatch, hardening, save, and Sworm writes.

Inputs (read both files; do not re-derive):
- Plan draft: ${args.planPath}
- Verification findings (spec.spec-verifier): ${args.verificationPath}

Resolve checkpoints in order; do not skip:
1. Read the plan and verification.
2. Interview the user with the ask_user tool. One focused question per call. Cover only spec shape, scope, and durable decisions surfaced by the verifier; skip what the inputs already settle.
3. Call the subagent tool to run spec.spec-architect with a task that includes plan path, verification contents, and the interview answers. Returns an unsaved spec draft. Treat as canonical; do not rewrite stylistically.
4. Call the subagent tool to run spec.spec-reviewer with the plan path, verification, answers, and architect draft. Returns review findings.
5. Resolve every blocker in the review findings; if any new critical ambiguity remains, ask_user before continuing.
6. Generate the candidate spec text in memory with provisional task keys, not saved placeholder Sworm IDs.
   - For \`review_plan: true\` plans, convert every Blocking and Required review card into required §T work with acceptance tied to the card's evidence/fix direction.
   - Keep Suggestions advisory by default in Risks, Notes, or Non-goals; create §T work for a Suggestion only when its Spec promotion note contains explicit opt-in metadata.
   - Preserve severity and scope in task descriptions or implementation notes so review provenance survives promotion.
7. Call isolated AskClaude to harden the candidate spec end-to-end.
8. If AskClaude fails, ask_user for a recovery choice: retry, model/config adjustment, manual Claude prompt, waiver, or abort.
9. ask_user for explicit final approval. Sworm writes are durable.
10. After approval only, call approve_spec_finalization with a short approval record. If approval is not granted or approve_spec_finalization fails, stop before Sworm writes.
11. Set Sworm prefixes with sworm_config_set: epic_prefix=EPIC, issue_prefix=ISSUE, comment_prefix=NOTE.
12. Create one Sworm EPIC for the spec.
13. Create one top-level ISSUE per §T row using EPIC/ISSUE/NOTE prefixes only.
14. Mirror §T dependencies with sworm_dependency_add.
15. Round-trip Sworm EPIC/ISSUE IDs into the spec text and save spec files once with save_spec under .sworm/spec/<name>/. Include Current State markers (todo.md for phased/ticketed; SPEC.md for light), sworm_epic_id frontmatter, and AskClaude hardening or waiver metadata.
16. Re-save plan frontmatter with promoted_to and promoted_at via save_plan_draft.

Required shape files:
- phased: .sworm/spec/<name>/todo.md + phase-*.md
- ticketed: .sworm/spec/<name>/todo.md + ticket-*.md
- light: .sworm/spec/<name>/SPEC.md`
}
