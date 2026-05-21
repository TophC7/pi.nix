export const COMMIT_PROMPT = `Create a conventional commit from pre-collected staged git changes.

Workflow:
1. Use the /commit pre-collected staged context below.
   - /commit already verified that the staged diff is non-empty before this agent turn.
   - Do not rerun \`git diff\` or \`git status\` for staging decisions.
2. Draft a conventional commit message from the staged context only.
   - First line: \`type(scope): summary\`
   - Keep summary under 72 characters.
   - Use best type: feat, fix, refactor, chore, docs, style, test, perf, ci, build.
   - Scope optional; include only when useful.
   - Add short body bullets only for multiple notable changes.
   - Do not include trailers.
3. Create the commit once, non-interactively, with fish syntax:

\`\`\`fish
set commit_message (string join \\n -- "type(scope): summary line" "" "- important detail 1" "- important detail 2" | string collect)

git commit -m "$commit_message"
\`\`\`

Rules:
- Commit only already-staged changes.
- Do not edit files, stage files, unstage files, amend, retry, or bypass hooks.
- If commit fails, show error output and exact attempted commit message, then stop.
- If commit succeeds, show commit hash and summary briefly.`

export const PR_PROMPT = `Create a pull request from pre-collected committed and pushed changes.

Workflow:
1. Use the /pr pre-collected branch context below.
   - /pr already inspected current branch, base branch, commits on \`<base>..HEAD\`, \`<base>...HEAD\` diff stat, worktree status, and upstream.
   - Do not rerun branch inspection commands unless the pre-collected context explicitly says data is unavailable.
2. If uncommitted changes exist, warn briefly, but use committed diff only.
3. Decide PR branch:
   - Treat \`dev/*\` branches as local-only.
   - Never push \`dev/*\`.
   - From \`dev/*\`, create the suggested PR branch pointer at current committed HEAD with \`git branch <pr-branch-name>\`, without checking it out.
   - Otherwise use current branch as PR branch.
4. Ensure PR branch is pushed:
   - \`git push -u origin <pr-branch-name>\`
   - If PR creation fails because remote branch is missing or stale, push once and retry PR creation once.
5. Draft PR title and body from pre-collected commits and \`<base>...HEAD\` diff summary.
   - Title: concise conventional-style, under 70 characters.
   - Body format exactly:

\`\`\`md
## Summary
- bullet 1
- bullet 2
\`\`\`

6. Create PR once with explicit head:

\`\`\`fish
set pr_body (string join \\n -- "## Summary" "- bullet 1" "- bullet 2" | string collect)

gh pr create --head "<pr-branch-name>" --title "the title" --body "$pr_body"
\`\`\`

Rules:
- Base PR on committed changes only.
- Do not edit files, create commits, amend commits, or fix branch state beyond allowed branch pointer creation and push.
- Do not include Test plan, Testing, or How to test sections.
- If PR creation fails after allowed push-and-retry, show error output plus exact title and body attempted, then stop.
- If PR succeeds, return PR URL only.`
