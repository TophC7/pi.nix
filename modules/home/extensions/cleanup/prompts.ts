export interface CleanupApplyArgs {
  diff: string
  findings: string
  focus?: string
}

function focusLine(focus?: string): string {
  return focus ? `\nAdditional focus: ${focus}\n` : ''
}

function fencedDiff(diff: string): string {
  return `\`\`\`diff\n${diff}\n\`\`\``
}

export function cleanupReuseTask(diff: string, focus?: string): string {
  return `Run the /cleanup reuse pass.
${focusLine(focus)}
Diff under review:
${fencedDiff(diff)}

Search the repository for existing utilities, helpers, hooks, or primitives that the diff duplicates or reinvents.

Rules:
- Read-only.
- Cite paths and line ranges for both the duplicated code and the existing target.
- Skip findings without a concrete existing symbol to swap to.
- Do not flag simple code merely for being short.

Return concise findings only. For each finding include:
- file path and line range of the new code;
- existing symbol or file the code should reuse;
- one-sentence reason;
- severity: blocking / required / suggestion.`
}

export function cleanupQualityTask(diff: string, focus?: string): string {
  return `Run the /cleanup quality pass.
${focusLine(focus)}
Diff under review:
${fencedDiff(diff)}

Flag dead code, debug remnants, slop, hacky patterns, and over-engineering in the changed scope.

Rules:
- Read-only.
- Cite paths and line ranges. Skip findings you cannot anchor to a location.
- Report only evidence-backed findings.
- Do not flag legacy code that the diff does not touch.

Return concise findings only. For each finding include:
- file path and line range;
- one-sentence failure mode;
- one-sentence concrete fix;
- severity: blocking / required / suggestion.`
}

export function cleanupEfficiencyTask(diff: string, focus?: string): string {
  return `Run the /cleanup efficiency pass.
${focusLine(focus)}
Diff under review:
${fencedDiff(diff)}

Flag wasted work, missed concurrency, hot-path bloat, no-op updates, and memory issues in the changed scope.

Rules:
- Read-only.
- Cite paths and line ranges. Skip findings you cannot anchor to a location.
- Quantify the win in plain words.

Return concise findings only. For each finding include:
- file path and line range;
- one-sentence failure mode plus the win;
- one-sentence concrete fix;
- severity: blocking / required / suggestion.`
}

export function cleanupApplyPrompt(args: CleanupApplyArgs): string {
  // IMPORTANT: Do NOT lead this prompt with slash-command-shaped text (e.g.
  // `/cleanup ...`). Pi's command parser will hijack the first token and
  // corrupt the prompt body. Lead with prose.
  return `Apply cleanup findings to the working tree.

Inputs are inline below. Do not re-derive the findings unless needed to verify safety.
${args.focus ? `\nUser focus: ${args.focus}\n` : ''}
Diff under review:
${fencedDiff(args.diff)}

Combined findings from cleanup.cleanup-reuse-scout, cleanup.cleanup-quality-scout, cleanup.cleanup-efficiency-scout:
\`\`\`md
${args.findings}
\`\`\`

Mode rules:
1. Apply only findings that are clearly correct and worth doing now. Skip false positives without arguing.
2. Stay in lane: change only the lines a finding identifies; do not refactor surrounding code.
3. Preserve behavior, error handling, and existing abstraction boundaries.
4. Do not stage, commit, or push. The user reviews before committing.

After applying, return one tight summary block:
- Applied: bulleted list, one short line per fix with file:line.
- Skipped: bulleted list, one short line per skipped finding with the reason it was wrong or out of scope. Omit the section if empty.
- Worth a look: bulleted list of any finding you considered but did not apply because it is risky, ambiguous, or larger than /cleanup scope. One short reason each. Omit the section if empty.

Keep the summary tight. No narration, no preamble.`
}

export function cleanupQuickPrompt(): string {
  return `Quick cleanup pass on the current working tree.

Delete only:
1. console.log / console.warn / console.error / debugger statements.
2. Unused imports (verify the symbol is unreferenced in the file).
3. Empty catch blocks (e.g. \`catch (e) {}\` with no body).

Do not touch:
- Commented-out code (review only).
- Defensive patterns or error handling.
- Anything that might be intentional.

For each deletion, confirm safety by searching for references first. Do not stage or commit. Return a short list of what was removed; if nothing was removed, say so in one line.`
}
