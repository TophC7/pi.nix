import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExtensionContext } from '@mariozechner/pi-coding-agent'
import type { IssueSummary } from '../sworm-issues.ts'
import { callBridge, readBridgeEnv, SwormBridgeError, swormEnvMissingText } from '../sworm-issues.ts'
import { extractEpicIds, readSpecFiles } from './spec-files.ts'
import type { SpecInfo, TaskSummary } from './types.ts'

export type SwormIssue = IssueSummary & {
  description?: string | null
  contextJson?: string | null
}

export type SwormEpic = {
  id: string
  title: string
  description?: string | null
  status: string
  priority: number
}

export type SwormComment = {
  id: string
  issueId: string
  author: string
  body: string
  createdAt?: string
}

export type SwormBridgeInfo = {
  protocol_version?: number
  project_id?: string
  project_path?: string
  capabilities?: string[]
  methods?: string[]
}

export type SpecSwormState = {
  epicId: string
  epic: SwormEpic
  issues: SwormIssue[]
  ready: SwormIssue[]
  comments: SwormComment[]
  summary: TaskSummary
}

export async function requireSwormBridge(ctx: ExtensionContext): Promise<boolean> {
  const env = readBridgeEnv()
  if (!env) {
    ctx.ui.notify(swormEnvMissingText(), 'error')
    return false
  }
  try {
    const info = await callBridge<SwormBridgeInfo>('bridge.info')
    if (info.protocol_version !== 1) {
      throw new SwormBridgeError(
        'protocol_mismatch',
        `Sworm issue bridge protocol mismatch: expected 1, got ${info.protocol_version ?? 'unknown'}`
      )
    }
    if (!info.project_path) {
      throw new SwormBridgeError(
        'protocol_mismatch',
        'Sworm issue bridge did not return project_path; restart Sworm and Pi.'
      )
    }
    const cwd = canonicalPath(ctx.cwd)
    const envPath = canonicalPath(env.projectPath)
    const bridgePath = canonicalPath(info.project_path)
    if (cwd !== envPath || cwd !== bridgePath) {
      ctx.ui.notify(`Sworm bridge project mismatch. cwd=${cwd}; env=${envPath}; bridge=${bridgePath}`, 'error')
      return false
    }
    return true
  } catch (error) {
    ctx.ui.notify(formatBridgeError(error), 'error')
    return false
  }
}

export async function bridgeInfo(): Promise<SwormBridgeInfo> {
  return callBridge<SwormBridgeInfo>('bridge.info')
}

export function resolveSpecEpicId(spec: SpecInfo, content?: string): string | undefined {
  if (spec.swormEpicId) return spec.swormEpicId
  const ids = extractEpicIds(content ?? readSpecFiles(spec))
  return ids.length === 1 ? ids[0] : undefined
}

export async function loadSpecSwormState(spec: SpecInfo): Promise<SpecSwormState> {
  const epicId = resolveSpecEpicId(spec)
  if (!epicId) throw new SwormBridgeError('missing_epic', `Spec missing sworm_epic_id / EPIC id: ${spec.path}`)
  const [epic, issues, ready] = await Promise.all([
    callBridge<SwormEpic>('epic.show', { epicId }),
    callBridge<SwormIssue[]>('issue.list', {
      filters: { epicId, includeArchived: true, limit: 500 }
    }),
    callBridge<SwormIssue[]>('issue.ready', { filters: { epicId, limit: 50 } })
  ])
  const comments = (
    await Promise.all(
      issues.map((issue) => callBridge<SwormComment[]>('comment.list', { issueId: issue.id }).catch(() => []))
    )
  ).flat()
  return {
    epicId,
    epic,
    issues,
    ready,
    comments,
    summary: summarizeIssues(issues, ready, comments)
  }
}

export function summarizeIssues(issues: SwormIssue[], ready: SwormIssue[], comments: SwormComment[]): TaskSummary {
  const counts: Record<string, number> = {}
  for (const issue of issues) counts[issue.status] = (counts[issue.status] ?? 0) + 1
  const readyLine = ready[0] ? formatIssueLine(ready[0]) : 'none'
  const blockers = issues.filter((issue) => issue.status === 'blocked').map((issue) => formatIssueLine(issue))
  for (const comment of comments) {
    if (/\bblock(ed|er|ing)?\b/i.test(comment.body)) blockers.push(`${comment.issueId}: ${firstLine(comment.body)}`)
  }
  const manualChecks = comments
    .filter((comment) => /manual/i.test(comment.body))
    .map((comment) => `${comment.issueId}: ${firstLine(comment.body)}`)
  return {
    counts,
    readyLine,
    blockers: [...new Set(blockers)],
    manualChecks: [...new Set(manualChecks)]
  }
}

export function formatCounts(counts: Record<string, number>): string {
  const order = ['todo', 'in_progress', 'blocked', 'completed', 'wont_fix', 'archived']
  const parts = order.filter((key) => counts[key]).map((key) => `${key}:${counts[key]}`)
  const extra = Object.keys(counts)
    .filter((key) => !order.includes(key))
    .sort()
    .map((key) => `${key}:${counts[key]}`)
  return [...parts, ...extra].join(' ') || 'none'
}

export function formatIssueLine(issue: SwormIssue): string {
  const assignee = issue.assigneeId ? ` @${issue.assigneeId}` : ''
  return `${issue.id} | P${issue.priority} | ${issue.status}${assignee} | ${issue.title}`
}

export function formatState(state: SpecSwormState): string {
  return [
    `Epic: ${state.epic.id} | ${state.epic.status} | ${state.epic.title}`,
    `Issues: ${formatCounts(state.summary.counts)}`,
    `Ready next: ${state.summary.readyLine}`,
    `Blockers: ${state.summary.blockers.length ? state.summary.blockers.join('; ') : 'none'}`,
    `Manual checks: ${state.summary.manualChecks.length ? state.summary.manualChecks.join('; ') : 'none recorded'}`
  ].join('\n')
}

export function specWorkPrompt(spec: SpecInfo, state: SpecSwormState): string {
  return `Run /spec:work for ${spec.path}

Spec shape: ${spec.shape}
Sworm epic: ${state.epic.id}
Current Sworm state:
${formatState(state)}

Rules:
- Read every markdown file in ${spec.path} before editing.
- Use Sworm issue state, not markdown order.
- Use sworm_issue_ready with epicId ${state.epic.id} to choose ready work.
- Claim the first ready ISSUE with sworm_issue_claim before editing.
- Restore implementation discipline: inspect reuse before abstractions, avoid scope creep.
- Run every runnable run: acceptance check for each completed issue under Fish.
- Record manual: checks with sworm_comment_add; manual checks do not block automated close.
- Complete with sworm_comment_add containing automated check summary, then sworm_issue_update status completed.
- Continue ready queue until no ready issue remains or true blocker appears.
- On true blocker, add Sworm comment, update §B in relevant spec file, ask_user with recovery options, stop.

Initial ready issues:
${state.ready.length ? state.ready.map(formatIssueLine).join('\n') : 'No ready issues.'}`
}

export function formatBridgeError(error: unknown): string {
  if (error instanceof SwormBridgeError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() || ''
}
