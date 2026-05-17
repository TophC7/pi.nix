// ## SWORM BATCH ## //
// Host-side wrapper around the one-at-a-time Sworm bridge calls.
// Agent calls ONE tool (sdd_spec_apply); this file fans out the N bridge
// calls in order and best-effort rolls back on failure. When Sworm grows an
// atomic spec.apply method this whole file shrinks to one callBridge call.

import { callBridge, SwormBridgeError, swormAgentId, type IssueSummary } from '../sworm-issues.ts'
import type { Spec, SpecAcceptance, SpecTask } from './parser.ts'

const DEFAULT_EPIC_PREFIX = 'EPIC'
const DEFAULT_ISSUE_PREFIX = 'ISSUE'
const DEFAULT_COMMENT_PREFIX = 'NOTE'

let prefixSetup: Promise<void> | undefined

export interface ApplyResult {
  epicId: string
  issueIds: Record<string, string>
  created: string[]
  updated: string[]
  archived: string[]
  depEdges: number
}

export class SpecApplyError extends Error {
  partial?: { epicId?: string; issueIds: Record<string, string> }
  constructor(message: string, partial?: SpecApplyError['partial']) {
    super(message)
    this.name = 'SpecApplyError'
    this.partial = partial
  }
}

export async function applySpec(spec: Spec): Promise<ApplyResult> {
  await ensurePrefixes()
  const existingEpicId = spec.frontmatter.epicId?.trim()
  if (existingEpicId) {
    return reshipExisting(spec, existingEpicId)
  }
  return firstShip(spec)
}

// ## FIRST SHIP ## //
// New epic. Track everything created so we can attempt rollback if any later
// call throws. Sworm has no transactions; this is the best we can do.
async function firstShip(spec: Spec): Promise<ApplyResult> {
  const createdIssueIds: string[] = []
  let epicId: string | undefined
  try {
    const epic = await createEpic(spec.frontmatter.title, spec.goal)
    epicId = epic.id
    const issueIds: Record<string, string> = {}
    const results = await Promise.allSettled(
      spec.tasks.map(async (task) => ({
        task,
        issue: await createIssue(epic.id, task)
      }))
    )
    const failures: string[] = []
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(formatError(result.reason))
        continue
      }
      issueIds[result.value.task.slug] = result.value.issue.id
      createdIssueIds.push(result.value.issue.id)
    }
    if (failures.length > 0) throw new Error(`issue creation failed: ${failures.join('; ')}`)
    const depEdges = await applyDeps(spec.tasks, issueIds)
    return {
      epicId: epic.id,
      issueIds,
      created: Object.keys(issueIds),
      updated: [],
      archived: [],
      depEdges
    }
  } catch (error) {
    const rollbackFailures = await rollback(createdIssueIds, epicId)
    const rollbackText = rollbackFailures.length ? ` Rollback failures: ${rollbackFailures.join('; ')}` : ''
    throw new SpecApplyError(
      `spec.apply failed during first ship: ${formatError(error)}.${rollbackText}`,
      { epicId, issueIds: {} }
    )
  }
}

// ## RE-SHIP ## //
// Diff spec against current Sworm state by slug. Slug identity comes from the
// id=ISSUE-N anchor recorded on the previous ship. Unknown-slug issues under
// the epic are left alone; they may be hand-created and we shouldn't touch
// them.
async function reshipExisting(spec: Spec, epicId: string): Promise<ApplyResult> {
  const existing = await loadEpicIssues(epicId)
  const issueById = new Map(existing.map((issue) => [issue.id, issue]))
  const slugByIssueId = new Map(
    spec.tasks.flatMap((task) => (task.issueId ? [[task.issueId, task.slug] as const] : []))
  )
  const specSlugs = new Set(spec.tasks.map((task) => task.slug))
  const issueIds: Record<string, string> = {}
  const created: string[] = []
  const updated: string[] = []
  const archived: string[] = []

  // Update epic in case title/goal changed.
  await updateEpic(epicId, spec.frontmatter.title, spec.goal)

  const taskResults = await Promise.allSettled(
    spec.tasks.map(async (task) => {
      const known = task.issueId ? issueById.get(task.issueId) : undefined
      if (known) {
        await updateIssue(known.id, task)
        return { kind: 'updated' as const, slug: task.slug, issueId: known.id }
      }
      const createdIssue = await createIssue(epicId, task)
      return { kind: 'created' as const, slug: task.slug, issueId: createdIssue.id }
    })
  )
  const failures: string[] = []
  for (const result of taskResults) {
    if (result.status === 'rejected') {
      failures.push(formatError(result.reason))
      continue
    }
    issueIds[result.value.slug] = result.value.issueId
    if (result.value.kind === 'created') created.push(result.value.slug)
    else updated.push(result.value.slug)
  }
  if (failures.length > 0) throw new Error(`issue sync failed: ${failures.join('; ')}`)

  // Archive issues that previously matched a slug-anchored spec task but are
  // no longer present. Hand-created issues without a slug stay untouched.
  const archiveTargets = existing.filter((issue) => {
    const slug = slugByIssueId.get(issue.id)
    return Boolean(slug && !specSlugs.has(slug))
  })
  const archiveResults = await Promise.allSettled(archiveTargets.map((issue) => archiveIssue(issue.id)))
  for (let index = 0; index < archiveResults.length; index++) {
    const result = archiveResults[index]
    const issue = archiveTargets[index]
    if (!issue) continue
    if (result?.status === 'rejected') failures.push(`${issue.id}: ${formatError(result.reason)}`)
    else archived.push(issue.id)
  }
  if (failures.length > 0) throw new Error(`issue archive failed: ${failures.join('; ')}`)

  const depEdges = await applyDeps(spec.tasks, issueIds)
  return { epicId, issueIds, created, updated, archived, depEdges }
}

// ## PRIMITIVES ## //
// Thin wrappers over callBridge so the orchestration above reads as intent.

async function ensurePrefixes(): Promise<void> {
  prefixSetup ??= Promise.all([
    safeSetConfig('epic_prefix', DEFAULT_EPIC_PREFIX),
    safeSetConfig('issue_prefix', DEFAULT_ISSUE_PREFIX),
    safeSetConfig('comment_prefix', DEFAULT_COMMENT_PREFIX)
  ])
    .then(() => undefined)
    .catch((error) => {
      prefixSetup = undefined
      throw error
    })
  await prefixSetup
}

async function safeSetConfig(key: string, value: string): Promise<void> {
  try {
    await callBridge('config.set', { key, value })
  } catch (error) {
    if (isBenignBridgeConflict(error)) return
    throw new Error(`config.set ${key}=${value} failed: ${formatError(error)}`)
  }
}

async function createEpic(title: string, description: string): Promise<{ id: string }> {
  return await callBridge<{ id: string }>('epic.create', {
    title,
    description: description || null,
    actor: swormAgentId()
  })
}

async function updateEpic(epicId: string, title: string, description: string): Promise<void> {
  await callBridge('epic.update', {
    epicId,
    patch: {
      title,
      description: description || null,
      actor: swormAgentId()
    }
  })
}

async function loadEpicIssues(epicId: string): Promise<IssueSummary[]> {
  return await callBridge<IssueSummary[]>('issue.list', {
    filters: { epicId, includeArchived: false, limit: 500 }
  })
}

async function createIssue(epicId: string, task: SpecTask): Promise<{ id: string }> {
  return await callBridge<{ id: string }>('issue.create', {
    title: task.title,
    description: composeIssueDescription(task),
    epicId,
    contextJson: contextForTask(task),
    actor: swormAgentId()
  })
}

async function updateIssue(issueId: string, task: SpecTask): Promise<void> {
  await callBridge('issue.update', {
    issueId,
    patch: {
      title: task.title,
      description: composeIssueDescription(task),
      contextJson: contextForTask(task),
      actor: swormAgentId()
    }
  })
}

async function archiveIssue(issueId: string): Promise<void> {
  await callBridge('issue.update', {
    issueId,
    patch: {
      status: 'archived',
      actor: swormAgentId()
    }
  })
}

async function applyDeps(tasks: SpecTask[], issueIds: Record<string, string>): Promise<number> {
  const edges = tasks.flatMap((task) => {
    const issueId = issueIds[task.slug]
    if (!issueId) return []
    return task.deps.flatMap((depSlug) => {
      const dependsOnIssueId = issueIds[depSlug]
      return dependsOnIssueId ? [{ issueId, dependsOnIssueId }] : []
    })
  })
  const results = await Promise.allSettled(
    edges.map((edge) =>
      callBridge('dependency.add', {
        ...edge,
        actor: swormAgentId()
      })
    )
  )
  const failures: string[] = []
  let count = 0
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    const edge = edges[index]
    if (!edge) continue
    if (result?.status === 'fulfilled') {
      count++
    } else if (result?.status === 'rejected' && !isBenignBridgeConflict(result.reason)) {
      failures.push(`${edge.issueId}->${edge.dependsOnIssueId}: ${formatError(result.reason)}`)
    }
  }
  if (failures.length > 0) throw new Error(`dependency sync failed: ${failures.join('; ')}`)
  return count
}

// NOTE: composeIssueDescription keeps acceptance and deps visible inside the
// Sworm description so /spec:work doesn't need a second round-trip just to
// learn the gate. contextJson stays the canonical structured form.
function composeIssueDescription(task: SpecTask): string {
  const sections: string[] = []
  if (task.description.trim()) sections.push(task.description.trim())
  if (task.acceptance) sections.push(formatAcceptance(task.acceptance))
  if (task.deps.length > 0) sections.push(`Depends on: ${task.deps.join(', ')}`)
  return sections.join('\n\n')
}

function formatAcceptance(acceptance: SpecAcceptance): string {
  if (acceptance.kind === 'runnable') return `Acceptance (runnable): \`${acceptance.value}\``
  return `Acceptance: ${acceptance.value}`
}

function contextForTask(task: SpecTask): string {
  return JSON.stringify({
    sddSlug: task.slug,
    sddDeps: task.deps,
    sddAcceptance: task.acceptance ?? null
  })
}

async function rollback(issueIds: string[], epicId: string | undefined): Promise<string[]> {
  const failures: string[] = []
  for (const id of issueIds.reverse()) {
    try {
      await callBridge('issue.delete', { issueId: id })
    } catch (error) {
      failures.push(`issue.delete ${id}: ${formatError(error)}`)
    }
  }
  if (epicId) {
    try {
      await callBridge('epic.delete', { epicId })
    } catch (error) {
      failures.push(`epic.delete ${epicId}: ${formatError(error)}`)
    }
  }
  return failures
}

function isBenignBridgeConflict(error: unknown): boolean {
  if (!(error instanceof SwormBridgeError)) return false
  return /already|exists|duplicate|same|unchanged/i.test(`${error.code} ${error.message}`)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
