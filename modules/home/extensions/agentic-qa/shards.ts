// ## SHARDS ## //
// Granular QA shard planning. Mission runs can be split directly from the
// compiled QaRunSpec; staged/freehand runs can ask a tiny non-browser planner
// subagent to call a typed shard-planning tool.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { containsCredentialLeak } from './artifacts.ts'
import { safePathSegment } from './artifact-paths.ts'
import { fenced } from './markdown.ts'
import {
  QA_EVIDENCE_TYPE_HELP,
  normalizeQaEvidenceType,
  renderRunSpec,
  type QaMode,
  type QaRequiredEvidence,
  type QaRunSpec,
  type QaScenarioSpec
} from './run-state.ts'
import { createQaShardRunSpec } from './worker.ts'

export const QA_SHARD_PLAN_VERSION = 1
export const QA_SHARD_PLAN_FILENAME = 'shards.json'
export const QA_SHARD_STATE_FILENAME = 'shard-state.json'
export const QA_PLANNER_AGENT = 'agentic-qa.qa-planner'

const QA_SHARD_CHILD_INDEX_DIR = '_child-runs'

export interface QaShardPlan {
  readonly version: typeof QA_SHARD_PLAN_VERSION
  readonly parentRunId: string
  readonly mode: QaMode
  readonly slug: string
  readonly target: string
  readonly relativeRunDir: string
  readonly relativePlanPath: string
  readonly shards: readonly QaShardSpec[]
}

export interface QaShardSpec {
  readonly shardId: string
  readonly scenarioId: string
  readonly title: string
  readonly target: string
  readonly given: readonly string[]
  readonly when: readonly string[]
  readonly then: readonly string[]
  readonly checks: readonly string[]
  readonly requiredEvidence: readonly QaRequiredEvidence[]
  readonly safetyNotes: readonly string[]
  readonly relativeArtifactDir: string
}

export type QaShardStatus = 'queued' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'blocked'
export type QaSourceCommandKind = 'qa' | 'qa:staged' | 'qa:freehand'

export interface QaShardRunState {
  readonly version: typeof QA_SHARD_PLAN_VERSION
  readonly parentRunId: string
  readonly target: string
  readonly sourceCommand: QaSourceCommandKind
  readonly shardPlanPath: string
  readonly relativeRunDir: string
  readonly shards: readonly QaShardStateEntry[]
}

interface QaShardChildRunIndex {
  readonly version: typeof QA_SHARD_PLAN_VERSION
  readonly childRunId: string
  readonly shardStatePath: string
}

export interface QaShardStateEntry {
  readonly shardId: string
  readonly scenarioId: string
  readonly title: string
  readonly status: QaShardStatus
  readonly childRunId: string
  readonly relativeArtifactDir: string
  readonly artifactPaths: readonly string[]
  readonly reportPath?: string
  readonly reportJsonPath?: string
  readonly updatedAt: string
}

export interface QaShardStatePatch {
  readonly status?: QaShardStatus
  readonly childRunId?: string
  readonly artifactPaths?: readonly string[]
  readonly reportPath?: string
  readonly reportJsonPath?: string
  readonly updatedAt?: string
}

export interface QaShardPlannerInput {
  readonly spec: QaRunSpec
  readonly context: string
  readonly sourceCommand: QaSourceCommandKind
  readonly extra?: string
}

export interface QaShardPlanToolEvidenceInput {
  readonly type: string
  readonly purpose: string
  readonly scenarioId?: string
}

export interface QaShardPlanToolScenarioInput {
  readonly scenarioId?: string
  readonly title: string
  readonly given: readonly string[]
  readonly when: readonly string[]
  readonly then: readonly string[]
  readonly checks: readonly string[]
  readonly requiredEvidence: readonly QaShardPlanToolEvidenceInput[]
  readonly safetyNotes?: readonly string[]
}

export interface QaShardPlanToolInput {
  readonly runId: string
  readonly shards: readonly QaShardPlanToolScenarioInput[]
  readonly safetyNotes?: readonly string[]
}

export interface QaShardPlannerResult {
  readonly shardPlan: QaShardPlan
  readonly shardState: QaShardRunState
  readonly planPath: string
  readonly statePath: string
}

export interface QaShardPlanToolResult {
  readonly accepted: boolean
  readonly runId: string
  readonly invalid: readonly string[]
  readonly shardCount: number
  readonly planPath?: string
  readonly statePath?: string
}

interface ActiveQaShardPlannerRun {
  readonly spec: QaRunSpec
  readonly cwd: string
  readonly sourceCommand: QaSourceCommandKind
  submitted?: QaShardPlannerResult
}

const activeQaShardPlanners = new Map<string, ActiveQaShardPlannerRun>()

interface PlannerEvidenceInput {
  readonly type?: unknown
  readonly purpose?: unknown
  readonly scenarioId?: unknown
}

export function compileDirectShardPlan(spec: QaRunSpec): QaShardPlan {
  return buildShardPlan(
    spec,
    spec.scenarios.map((scenario) => shardFromScenario(spec, scenario))
  )
}

export function qaShardPlanPath(spec: Pick<QaRunSpec, 'relativeRunDir'>): string {
  return `${spec.relativeRunDir}/${QA_SHARD_PLAN_FILENAME}`
}

export function qaShardStatePath(input: Pick<QaRunSpec | QaShardPlan, 'relativeRunDir'>): string {
  return `${input.relativeRunDir}/${QA_SHARD_STATE_FILENAME}`
}

export function shouldUsePlannerForShardPlan(spec: QaRunSpec): boolean {
  if (spec.mode === 'mission') return false
  return spec.scenarios.length === 1 && isEmptyScenario(spec.scenarios[0])
}

export function writeQaShardPlan(cwd: string, plan: QaShardPlan): string {
  const planPath = path.join(cwd, plan.relativePlanPath)
  mkdirSync(path.dirname(planPath), { recursive: true })
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
  return planPath
}

export function createInitialQaShardRunState(plan: QaShardPlan, sourceCommand: QaSourceCommandKind): QaShardRunState {
  const now = new Date().toISOString()
  return {
    version: QA_SHARD_PLAN_VERSION,
    parentRunId: plan.parentRunId,
    target: plan.target,
    sourceCommand,
    shardPlanPath: plan.relativePlanPath,
    relativeRunDir: plan.relativeRunDir,
    shards: plan.shards.map((shard) => ({
      shardId: shard.shardId,
      scenarioId: shard.scenarioId,
      title: shard.title,
      status: 'queued',
      childRunId: childRunIdForShard(plan.parentRunId, shard.shardId),
      relativeArtifactDir: shard.relativeArtifactDir,
      artifactPaths: [],
      updatedAt: now
    }))
  }
}

export function updateQaShardRunState(
  state: QaShardRunState,
  shardId: string,
  patch: QaShardStatePatch
): QaShardRunState {
  const shards = state.shards.map((shard) => {
    if (shard.shardId !== shardId) return shard
    return {
      ...shard,
      ...definedPatch(patch),
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
  })
  if (shards.every((shard, index) => shard === state.shards[index])) {
    throw new Error(`Unknown QA shard id: ${shardId}`)
  }
  return { ...state, shards }
}

export function writeQaShardRunState(cwd: string, state: QaShardRunState): string {
  const statePath = path.join(cwd, qaShardStatePath(state))
  mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
  writeQaShardChildRunIndexes(cwd, state)
  return statePath
}

export function readQaShardRunState(cwd: string, relativeRunDir: string): QaShardRunState {
  const statePath = path.join(cwd, qaShardStatePath({ relativeRunDir }))
  const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
  return validateShardRunState(parsed)
}

export function submitQaShardPlanToolInput(cwd: string, input: QaShardPlanToolInput): QaShardPlanToolResult {
  const active = activeQaShardPlanners.get(input.runId)
  if (!active) {
    return {
      accepted: false,
      runId: input.runId,
      invalid: [`no active QA shard planner run for runId ${input.runId}`],
      shardCount: 0
    }
  }
  if (active.cwd !== cwd) {
    return { accepted: false, runId: input.runId, invalid: ['planner cwd mismatch'], shardCount: 0 }
  }
  if (active.submitted) {
    return { accepted: false, runId: input.runId, invalid: ['qa_shard_plan may only be submitted once per planner run'], shardCount: 0 }
  }

  const invalid = validateQaShardPlanToolInput(input)
  if (invalid.length > 0) return { accepted: false, runId: input.runId, invalid, shardCount: input.shards?.length ?? 0 }

  const plan = buildShardPlan(active.spec, input.shards.map((entry, index) => shardFromToolInput(active.spec, entry, index)))
  const state = createInitialQaShardRunState(plan, active.sourceCommand)
  const planPath = writeQaShardPlan(cwd, plan)
  const statePath = writeQaShardRunState(cwd, state)
  active.submitted = { shardPlan: plan, shardState: state, planPath, statePath }

  return {
    accepted: true,
    runId: input.runId,
    invalid: [],
    shardCount: plan.shards.length,
    planPath: plan.relativePlanPath,
    statePath: qaShardStatePath(plan)
  }
}

export function registerQaShardPlannerRun(input: {
  readonly spec: QaRunSpec
  readonly cwd: string
  readonly sourceCommand: QaSourceCommandKind
}): void {
  activeQaShardPlanners.set(input.spec.runId, { ...input })
}

export function clearQaShardPlannerRun(runId: string): void {
  activeQaShardPlanners.delete(runId)
}

export function hydrateQaShardWorkerRun(cwd: string, runId: string): QaRunSpec | undefined {
  const statePath = readShardStatePathForChildRun(cwd, runId)
  if (!statePath) return undefined
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as QaShardRunState
    const entry = state.shards.find((item) => item.childRunId === runId)
    if (!entry) return undefined
    const plan = JSON.parse(readFileSync(path.join(cwd, state.shardPlanPath), 'utf8')) as QaShardPlan
    const shard = plan.shards.find((item) => item.shardId === entry.shardId)
    if (!shard) return undefined
    return createQaShardRunSpec(
      {
        target: plan.target,
        mode: plan.mode,
        slug: plan.slug,
        runId: plan.parentRunId,
        relativeRunDir: plan.relativeRunDir,
        relativeArtifactDir: path.join(cwd, entry.relativeArtifactDir),
        setup: [],
        scenarios: [],
        requiredEvidence: [],
        outOfScope: [],
        sourceFiles: [],
        tags: []
      },
      shard,
      entry
    )
  } catch {
    return undefined
  }
}

export function takeQaShardPlannerResult(runId: string): QaShardPlannerResult | undefined {
  const active = activeQaShardPlanners.get(runId)
  const submitted = active?.submitted
  activeQaShardPlanners.delete(runId)
  return submitted
}

export function buildQaShardPlannerTask(input: QaShardPlannerInput): string {
  return [
    'Plan granular browser-observable QA shards. Do not run browser tools.',
    '',
    'Pi will schedule the browser workers. Your only job is to call qa_shard_plan with typed shard fields.',
    `Run id: ${input.spec.runId}`,
    `Target: ${input.spec.target}`,
    `Mode: ${input.spec.mode}`,
    `Pi will save the accepted plan to: ${qaShardPlanPath(input.spec)}`,
    '',
    'Call qa_shard_plan exactly once with:',
    '- runId from this task',
    '- shards[] with atomic browser-observable checks',
    '- nonempty given, when, then, checks, and requiredEvidence for every shard',
    '',
    'Rules:',
    '- Keep each shard atomic: one scenario/check per browser worker when practical.',
    '- Use scenario ids S1, S2, S3, ... without gaps when you provide ids; Pi can assign missing ids by order.',
    `- Evidence types: ${QA_EVIDENCE_TYPE_HELP}`,
    '- Do not create or propose temp .qa.md files; this plan is transient for this run only.',
    '- Do not write JSON files yourself. The qa_shard_plan tool writes shards.json after validation.',
    '- Do not include credentials, tokens, PHI, cookies, passwords, or real user data.',
    '- After qa_shard_plan is accepted, reply with one short sentence. Do not include JSON in chat.',
    '',
    'Compiled provisional run spec:',
    fenced('text', renderRunSpec(input.spec)),
    '',
    'Planning context:',
    fenced('text', input.context || '<none>'),
    input.extra ? `\nAdditional user instructions:\n${input.extra}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runQaShardPlannerSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: QaShardPlannerInput
): Promise<QaShardPlannerResult> {
  const { runSubagent } = await import('@pi/lib/subagents')
  registerQaShardPlannerRun({ spec: input.spec, cwd: ctx.cwd, sourceCommand: input.sourceCommand })
  try {
    await runSubagent(
      pi,
      ctx,
      {
        agent: QA_PLANNER_AGENT,
        task: buildQaShardPlannerTask(input),
        context: 'fresh',
        agentScope: 'both'
      },
      `${input.spec.mode} QA planner`,
      `agentic-qa-plan:${input.spec.runId}`
    )
    const submitted = takeQaShardPlannerResult(input.spec.runId)
    if (!submitted) throw new Error(`QA shard planner did not submit qa_shard_plan for runId ${input.spec.runId}`)
    return submitted
  } finally {
    clearQaShardPlannerRun(input.spec.runId)
  }
}

function buildShardPlan(spec: QaRunSpec, shards: readonly QaShardSpec[]): QaShardPlan {
  return {
    version: QA_SHARD_PLAN_VERSION,
    parentRunId: spec.runId,
    mode: spec.mode,
    slug: spec.slug,
    target: spec.target,
    relativeRunDir: spec.relativeRunDir,
    relativePlanPath: qaShardPlanPath(spec),
    shards
  }
}

function shardFromScenario(spec: QaRunSpec, scenario: QaScenarioSpec): QaShardSpec {
  return {
    shardId: shardIdForScenario(scenario.id),
    scenarioId: scenario.id,
    title: scenario.title,
    target: spec.target,
    given: scenario.given,
    when: scenario.when,
    then: scenario.then,
    checks: scenario.checks,
    requiredEvidence: evidenceForScenario(spec, scenario),
    safetyNotes: [],
    relativeArtifactDir: `${spec.relativeRunDir}/${shardIdForScenario(scenario.id)}/artifacts`
  }
}

function shardFromToolInput(spec: QaRunSpec, entry: QaShardPlanToolScenarioInput, index: number): QaShardSpec {
  const scenarioId = stringValue(entry.scenarioId) || `S${index + 1}`
  return {
    shardId: shardIdForScenario(scenarioId),
    scenarioId,
    title: stringValue(entry.title) ?? `Scenario ${index + 1}`,
    target: spec.target,
    given: stringArray(entry.given),
    when: stringArray(entry.when),
    then: stringArray(entry.then),
    checks: stringArray(entry.checks),
    requiredEvidence: evidenceArray(entry.requiredEvidence, scenarioId),
    safetyNotes: stringArray(entry.safetyNotes),
    relativeArtifactDir: `${spec.relativeRunDir}/${shardIdForScenario(scenarioId)}/artifacts`
  }
}

function validateQaShardPlanToolInput(input: QaShardPlanToolInput): string[] {
  const invalid: string[] = []
  const seenShardIds = new Map<string, number>()
  if (!Array.isArray(input.shards) || input.shards.length === 0) invalid.push('shards must contain at least one shard')
  for (const [index, shard] of (input.shards ?? []).entries()) {
    const label = `shard ${index + 1}`
    const scenarioId = stringValue(shard.scenarioId) || `S${index + 1}`
    const shardId = shardIdForScenario(scenarioId)
    const firstIndex = seenShardIds.get(shardId)
    if (firstIndex !== undefined) {
      invalid.push(`${label} scenarioId ${scenarioId} duplicates shard ${firstIndex + 1} after normalization`)
    } else {
      seenShardIds.set(shardId, index)
    }
    if (!stringValue(shard.title)) invalid.push(`${label} title is required`)
    requireNonEmptyStringArray(shard.given, `${label} given`, invalid)
    requireNonEmptyStringArray(shard.when, `${label} when`, invalid)
    requireNonEmptyStringArray(shard.then, `${label} then`, invalid)
    requireNonEmptyStringArray(shard.checks, `${label} checks`, invalid)
    if (!Array.isArray(shard.requiredEvidence) || shard.requiredEvidence.length === 0) {
      invalid.push(`${label} requiredEvidence must contain at least one item`)
    }
    for (const [evidenceIndex, evidence] of (shard.requiredEvidence ?? []).entries()) {
      const evidenceLabel = `${label} requiredEvidence ${evidenceIndex + 1}`
      if (!normalizeQaEvidenceType(stringValue(evidence.type))) {
        invalid.push(`${evidenceLabel} type "${String(evidence.type)}" is invalid. ${QA_EVIDENCE_TYPE_HELP}`)
      }
      if (!stringValue(evidence.purpose)) invalid.push(`${evidenceLabel} purpose is required`)
    }
  }
  if (containsCredentialLeak(JSON.stringify(input))) invalid.push('shard plan contains credential-looking content')
  return invalid
}

function requireNonEmptyStringArray(value: unknown, label: string, invalid: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.every((entry) => !stringValue(entry))) {
    invalid.push(`${label} must contain at least one item`)
  }
}

function evidenceForScenario(spec: QaRunSpec, scenario: QaScenarioSpec): QaRequiredEvidence[] {
  const seen = new Set<string>()
  const result: QaRequiredEvidence[] = []
  const add = (evidence: QaRequiredEvidence) => {
    const scoped = evidence.scenarioId ? evidence : { ...evidence, scenarioId: scenario.id }
    const key = `${scoped.type}:${scoped.purpose}:${scoped.scenarioId ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(scoped)
  }
  for (const evidence of scenario.requiredEvidence) add(evidence)
  for (const evidence of spec.requiredEvidence) {
    if (!evidence.scenarioId || evidence.scenarioId === scenario.id) add(evidence)
  }
  return result
}

function evidenceArray(value: unknown, scenarioId: string): QaRequiredEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as PlannerEvidenceInput
    const type = normalizeQaEvidenceType(stringValue(candidate.type))
    const purpose = stringValue(candidate.purpose)
    if (!type || !purpose) return []
    return [{ type, purpose, scenarioId: stringValue(candidate.scenarioId) || scenarioId }]
  })
}

function childRunIdForShard(parentRunId: string, shardId: string): string {
  return safePathSegment(`${parentRunId}--${shardPathSegment(shardId, 'shard')}`)
}

function definedPatch(patch: QaShardStatePatch): QaShardStatePatch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as QaShardStatePatch
}

function validateShardRunState(value: unknown): QaShardRunState {
  if (!value || typeof value !== 'object') throw new Error('Invalid QA shard state: expected object')
  const candidate = value as QaShardRunState
  if (candidate.version !== QA_SHARD_PLAN_VERSION) throw new Error('Invalid QA shard state: unsupported version')
  if (!candidate.parentRunId || !candidate.target || !candidate.relativeRunDir || !candidate.shardPlanPath) {
    throw new Error('Invalid QA shard state: missing run metadata')
  }
  if (!['qa', 'qa:staged', 'qa:freehand'].includes(candidate.sourceCommand)) {
    throw new Error('Invalid QA shard state: invalid source command')
  }
  if (!Array.isArray(candidate.shards)) throw new Error('Invalid QA shard state: shards must be an array')
  for (const shard of candidate.shards) {
    if (!shard.shardId || !shard.scenarioId || !shard.childRunId || !isShardStatus(shard.status)) {
      throw new Error('Invalid QA shard state: malformed shard entry')
    }
  }
  return candidate
}

function isShardStatus(value: unknown): value is QaShardStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'inconclusive' ||
    value === 'blocked'
  )
}

function isEmptyScenario(scenario: QaScenarioSpec | undefined): boolean {
  return Boolean(
    scenario &&
      scenario.given.length === 0 &&
      scenario.when.length === 0 &&
      scenario.then.length === 0 &&
      scenario.checks.length === 0 &&
      scenario.requiredEvidence.length === 0
  )
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(stringValue).filter((entry): entry is string => Boolean(entry))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function shardIdForScenario(scenarioId: string): string {
  return `shard-${shardPathSegment(scenarioId, 'scenario')}`
}

function shardPathSegment(value: string, fallback: string): string {
  return /[A-Za-z0-9._-]/.test(value) ? safePathSegment(value) : fallback
}

function writeQaShardChildRunIndexes(cwd: string, state: QaShardRunState): void {
  const shardStatePath = qaShardStatePath(state)
  const indexDir = qaShardChildRunIndexDir(cwd)
  mkdirSync(indexDir, { recursive: true })
  for (const shard of state.shards) {
    const index: QaShardChildRunIndex = {
      version: QA_SHARD_PLAN_VERSION,
      childRunId: shard.childRunId,
      shardStatePath
    }
    writeFileSync(qaShardChildRunIndexPath(cwd, shard.childRunId), `${JSON.stringify(index, null, 2)}\n`)
  }
}

function readShardStatePathForChildRun(cwd: string, runId: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(qaShardChildRunIndexPath(cwd, runId), 'utf8')) as QaShardChildRunIndex
    if (parsed.version !== QA_SHARD_PLAN_VERSION || parsed.childRunId !== runId || !parsed.shardStatePath) return undefined
    return path.join(cwd, parsed.shardStatePath)
  } catch {
    return undefined
  }
}

function qaShardChildRunIndexDir(cwd: string): string {
  return path.join(cwd, '.sworm', 'qa', QA_SHARD_CHILD_INDEX_DIR)
}

function qaShardChildRunIndexPath(cwd: string, runId: string): string {
  return path.join(qaShardChildRunIndexDir(cwd), `${safePathSegment(runId)}.json`)
}

