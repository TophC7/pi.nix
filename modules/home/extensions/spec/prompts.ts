export const INTERVIEW_ANSWERS_MARKER = "<<< your answers below >>>";

function localDate(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function parseInterviewAnswers(raw: string | null | undefined): string {
	if (!raw) return "";
	const marker = raw.lastIndexOf(INTERVIEW_ANSWERS_MARKER);
	const body = (marker === -1 ? raw : raw.slice(marker + INTERVIEW_ANSWERS_MARKER.length)).trim();
	if (!body) return "";
	const meaningful = body.split("\n").some((line) => /[A-Za-z0-9]/.test(line));
	return meaningful ? body : "";
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
- Cite exact paths and line ranges where possible.`;
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
- Cite exact paths and line ranges where possible.`;
}

export function planInterviewPrefill(description: string, findings: string): string {
	return `Idea:
${description}

Context findings from subagents:
${findings}

Answer the questions that matter for this plan. If a question is irrelevant, say so.

${INTERVIEW_ANSWERS_MARKER}
- `;
}

export function planSynthesisTask(description: string, findings: string, answers: string): string {
	return `Create an unsaved /plan draft from the hardened idea context.

Original idea:
${description}

Subagent findings:
${findings}

User interview answers:
${answers}

Output a complete plan draft, but do not save files and do not create Sworm state.
Required sections:
- Goal
- Findings
- Options considered
- Recommended approach
- Risks
- Open questions resolved
- Critical files
- Promotion notes

Rules:
- Ground claims in the findings/code evidence.
- Preserve unresolved questions as risks; do not guess.
- Keep implementation tasks concrete enough for later /spec.`;
}

export interface PlanFinalizeArgs {
	description: string;
	findingsPath: string;
	answersPath: string;
	draftPath: string;
}

export function planFinalizePrompt(args: PlanFinalizeArgs): string {
	const date = localDate();
	return `Finalize Pi /plan for: ${args.description}

/plan discovery and interview are already complete. Treat the synthesizer draft as canonical; do not rewrite stylistically.

Inputs (read these files; do not re-derive):
- Subagent findings: ${args.findingsPath}
- User interview answers: ${args.answersPath}
- Unsaved plan draft from spec.plan-synthesizer: ${args.draftPath}

Mode rules:
1. Do not edit implementation files and do not create Sworm issue state.
2. Read the draft. If it contains a critical unsupported claim, ask_user once before proceeding; otherwise harden in place.
3. Produce final plan markdown with required frontmatter and sections below.
4. Before save, call isolated AskClaude to verify claims, risks, missing files, decisions, and promotion readiness.
5. If AskClaude fails, use ask_user recovery gate: retry, model/config adjustment, manual Claude prompt, waiver, or abort.
6. Save with save_plan_draft to .sworm/plans/${date}-<slug>.md.
7. After saving, ask_user: promote now, keep draft only, or revise.

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

Required sections: Goal, Findings, Options considered, Recommended approach, Risks, Open questions resolved, Critical files, Promotion notes.`;
}

export function specVerifierTask(planPath: string): string {
	return `Verify plan draft before /spec:new.

Plan path: ${planPath}

Read the plan and inspect relevant repo files. Return:
- plan assumptions with evidence or gaps;
- recommended spec shape: light, phased, or ticketed, with rationale;
- likely task boundaries and dependencies;
- acceptance/validation gates;
- risky durable decisions before Sworm issue creation;
- questions the user must answer before spec authoring.

Rules:
- Read-only. Do not edit or write files.
- Do not create Sworm state.
- Use fish-compatible read-only shell commands only.
- Cite exact paths and line ranges where possible.`;
}

export function specInterviewPrefill(planPath: string, verification: string): string {
	return `Plan path:
${planPath}

/spec verification findings:
${verification}

Answer shape/scope/durable-decision questions before spec authoring. If the recommendation is correct, confirm it.

${INTERVIEW_ANSWERS_MARKER}
- `;
}

export function specArchitectTask(planPath: string, verification: string, answers: string): string {
	return `Draft an unsaved /spec from the verified plan context.

Plan path: ${planPath}

Verification findings:
${verification}

User answers:
${answers}

Output an implementation-ready spec draft. Do not save files and do not create Sworm state.

Include:
- recommended spec name and shape;
- scope and non-goals;
- Current State block content;
- task rows suitable for Sworm ISSUE creation;
- dependencies between task rows;
- acceptance checks and manual checks;
- blockers/risks;
- exact files likely touched.

Use placeholders for future Sworm IDs. Keep tasks small and agent-executable.`;
}

export function specReviewTask(planPath: string, verification: string, answers: string, draft: string): string {
	return `Review unsaved /spec draft before durable writes.

Plan path: ${planPath}

Verification findings:
${verification}

User answers:
${answers}

Draft spec:
${draft}

Return evidence-backed review findings only:
- blocker issues before Sworm creation;
- missing decisions or unclear task boundaries;
- invalid assumptions against code;
- weak acceptance checks;
- suggested smallest fixes.

Rules:
- Read-only. Do not edit or write files.
- Do not create Sworm state.`;
}

export interface SpecFinalizeArgs {
	planPath: string;
	verificationPath: string;
	answersPath: string;
	draftPath: string;
	reviewPath: string;
}

export function specFinalizePrompt(args: SpecFinalizeArgs): string {
	return `Finalize Pi /spec:new from plan draft: ${args.planPath}

/spec verification and interview are already complete. Treat the architect draft as canonical; do not rewrite stylistically.

Inputs (read these files; do not re-derive):
- Verification findings (spec.spec-verifier): ${args.verificationPath}
- User interview answers: ${args.answersPath}
- Unsaved spec draft (spec.spec-architect): ${args.draftPath}
- Review findings (spec.spec-reviewer): ${args.reviewPath}

Resolve checkpoints in order; do not skip:
1. Read the plan draft and the four input paths above.
2. Resolve every blocker in the review findings; if any new critical ambiguity remains, ask_user before continuing.
3. Generate the candidate spec text in memory with placeholder EPIC/ISSUE IDs.
4. Call isolated AskClaude to harden the candidate spec end-to-end.
5. If AskClaude fails, use ask_user recovery gate: retry, model/config adjustment, manual Claude prompt, waiver, or abort.
6. ask_user for explicit final approval. Sworm writes are durable.
7. Save spec files with save_spec under .sworm/spec/<name>/. Include Current State markers (todo.md for phased/ticketed; SPEC.md for light) and frontmatter recording AskClaude hardening or waiver.
8. Create one Sworm EPIC for the spec.
9. Create one top-level ISSUE per §T row using EPIC/ISSUE/NOTE prefixes only.
10. Mirror §T dependencies with sworm_dependency_add.
11. Round-trip Sworm ISSUE IDs back into §T tables and re-save with save_spec. Add sworm_epic_id to frontmatter.
12. Re-save plan frontmatter with promoted_to and promoted_at via save_plan_draft.

Required shape files:
- phased: .sworm/spec/<name>/todo.md + phase-*.md
- ticketed: .sworm/spec/<name>/todo.md + ticket-*.md
- light: .sworm/spec/<name>/SPEC.md`;
}
