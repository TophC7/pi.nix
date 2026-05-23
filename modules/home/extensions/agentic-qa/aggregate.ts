// ## SHARD AGGREGATION ## //
// Builds the parent QA report from child shard reports. Chat memory is not a
// source of truth; child report.json files and shard-state drive aggregation.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writeQaFinishArtifacts } from './artifacts.ts'
import type {
  AcceptedQaPlan,
  QaEvidenceRecord,
  QaFinishBug,
  QaFinishResult,
  QaReportStatus,
  QaRequiredEvidence,
  QaRunSpec,
  QaScenarioCoverage,
  QaScenarioSpec,
  QaStepRecord
} from './run-state.ts'
import type { QaShardPlan, QaShardRunState, QaShardStateEntry } from './shards.ts'

export interface AggregateQaReportInput {
  readonly parentSpec: QaRunSpec
  readonly shardState: QaShardRunState
  readonly shardPlan?: QaShardPlan
  readonly summary?: string
}

interface ChildReportJson {
  readonly runId?: string
  readonly status?: QaReportStatus
  readonly summary?: string
  readonly blockers?: readonly string[]
  readonly failures?: readonly string[]
  readonly coverage?: readonly QaScenarioCoverage[]
  readonly missingEvidence?: readonly string[]
  readonly evidence?: readonly QaEvidenceRecord[]
  readonly steps?: readonly QaStepRecord[]
  readonly bugs?: readonly QaFinishBug[]
  readonly safetyNotes?: readonly string[]
  readonly nextSteps?: readonly string[]
  readonly acceptedPlan?: AcceptedQaPlan | null
}

export async function writeAggregateQaReport(cwd: string, input: AggregateQaReportInput) {
  const finish = computeAggregateQaFinish(cwd, input)
  const artifacts = await writeQaFinishArtifacts(cwd, finish)
  return { finish, artifacts }
}

export function computeAggregateQaFinish(cwd: string, input: AggregateQaReportInput): QaFinishResult {
  const aggregateSpec = specWithShardPlan(input.parentSpec, input.shardPlan)
  const childReports = input.shardState.shards.map((shard) => ({ shard, ...readChildReport(cwd, shard) }))
  const evidence: QaEvidenceRecord[] = []
  const steps: QaStepRecord[] = []
  const bugs: QaFinishBug[] = []
  const blockers: string[] = []
  const failures: string[] = []
  const missingEvidence: string[] = []
  const safetyNotes: string[] = []
  const nextSteps: string[] = []
  const acceptedScenarios: AcceptedQaPlan['scenarios'] = []
  const evidenceIds = new Map<string, string>()

  for (const { shard, report, error } of childReports) {
    if (error) {
      blockers.push(`shard ${shard.shardId} child report could not be read: ${error}`)
      continue
    }
    if (!report) {
      blockers.push(`shard ${shard.shardId} has no child report`)
      continue
    }

    for (const childEvidence of report.evidence ?? []) {
      const id = `E${evidence.length + 1}`
      evidenceIds.set(childEvidenceKey(report, childEvidence.id), id)
      evidence.push({ ...childEvidence, id })
    }

    for (const step of report.steps ?? []) {
      steps.push({
        ...step,
        runId: aggregateSpec.runId,
        evidenceIds: step.evidenceIds.map((id) => evidenceIds.get(childEvidenceKey(report, id)) ?? id)
      })
    }

    for (const bug of report.bugs ?? []) {
      bugs.push({
        claim: `shard ${shard.shardId}: ${bug.claim}`,
        evidenceIds: bug.evidenceIds.map((id) => evidenceIds.get(childEvidenceKey(report, id)) ?? id)
      })
    }

    for (const planScenario of report.acceptedPlan?.scenarios ?? []) acceptedScenarios.push(planScenario)
    for (const blocker of report.blockers ?? []) blockers.push(`shard ${shard.shardId}: ${blocker}`)
    for (const failure of report.failures ?? []) failures.push(`shard ${shard.shardId}: ${failure}`)
    for (const missing of report.missingEvidence ?? []) missingEvidence.push(`shard ${shard.shardId}: ${missing}`)
    for (const note of report.safetyNotes ?? []) safetyNotes.push(`shard ${shard.shardId}: ${note}`)
    for (const next of report.nextSteps ?? []) nextSteps.push(`shard ${shard.shardId}: ${next}`)
  }

  for (const shard of input.shardState.shards) {
    if (shard.status === 'failed') failures.push(`shard ${shard.shardId} failed`)
    if (shard.status === 'blocked') blockers.push(`shard ${shard.shardId} blocked`)
    if (shard.status === 'inconclusive') blockers.push(`shard ${shard.shardId} inconclusive`)
    if (shard.status === 'queued' || shard.status === 'running') blockers.push(`shard ${shard.shardId} not completed (${shard.status})`)
  }

  const status = aggregateStatus(input.shardState.shards)
  const coverage = aggregateCoverage(aggregateSpec, input.shardState)
  const acceptedPlan: AcceptedQaPlan = {
    runId: aggregateSpec.runId,
    target: aggregateSpec.target,
    acceptedScenarioIds: coverage.filter((entry) => entry.status === 'planned-tested').map((entry) => entry.scenarioId),
    scenarios: acceptedScenarios,
    outOfScope: [],
    safetyNotes,
    acceptedAt: new Date().toISOString()
  }

  return {
    status,
    runId: aggregateSpec.runId,
    summary: input.summary ?? aggregateSummary(input.shardState),
    blockers: unique(blockers),
    failures: unique(failures),
    coverage,
    missingEvidence: unique(missingEvidence),
    bugs,
    safetyNotes: unique(safetyNotes),
    nextSteps: unique(nextSteps),
    evidence,
    steps,
    acceptedPlan,
    spec: aggregateSpec
  }
}

function specWithShardPlan(parentSpec: QaRunSpec, shardPlan: QaShardPlan | undefined): QaRunSpec {
  if (!shardPlan) return parentSpec
  const scenarios: QaScenarioSpec[] = shardPlan.shards.map((shard) => ({
    id: shard.scenarioId,
    title: shard.title,
    given: shard.given,
    when: shard.when,
    then: shard.then,
    checks: shard.checks,
    requiredEvidence: shard.requiredEvidence
  }))
  return {
    ...parentSpec,
    scenarios,
    requiredEvidence: collectRequiredEvidence(scenarios)
  }
}

function collectRequiredEvidence(scenarios: readonly QaScenarioSpec[]): QaRequiredEvidence[] {
  const seen = new Set<string>()
  const result: QaRequiredEvidence[] = []
  for (const scenario of scenarios) {
    for (const evidence of scenario.requiredEvidence) {
      const scoped = evidence.scenarioId ? evidence : { ...evidence, scenarioId: scenario.id }
      const key = `${scoped.type}:${scoped.purpose}:${scoped.scenarioId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(scoped)
    }
  }
  return result
}

function aggregateStatus(shards: readonly QaShardStateEntry[]): QaReportStatus {
  if (shards.some((shard) => shard.status === 'failed')) return 'fail'
  if (shards.some((shard) => shard.status !== 'passed')) return 'inconclusive'
  return 'pass'
}

function aggregateCoverage(parentSpec: QaRunSpec, state: QaShardRunState): QaScenarioCoverage[] {
  const shardsByScenario = new Map(state.shards.map((shard) => [shard.scenarioId, shard]))
  return parentSpec.scenarios.map((scenario) => {
    const shard = shardsByScenario.get(scenario.id)
    const status = shard && (shard.status === 'passed' || shard.status === 'failed' || shard.status === 'inconclusive')
      ? 'planned-tested'
      : 'planned-untested'
    return { scenarioId: scenario.id, title: scenario.title, status }
  })
}

function aggregateSummary(state: QaShardRunState): string {
  const counts = new Map<string, number>()
  for (const shard of state.shards) counts.set(shard.status, (counts.get(shard.status) ?? 0) + 1)
  return `Aggregated ${state.shards.length} QA shard(s): ${[...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ')}`
}

function readChildReport(cwd: string, shard: QaShardStateEntry): { readonly report?: ChildReportJson; readonly error?: string } {
  const relativePath = shard.reportJsonPath
  if (!relativePath) return {}
  try {
    return { report: JSON.parse(readFileSync(path.join(cwd, relativePath), 'utf8')) as ChildReportJson }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `${relativePath}: ${message}` }
  }
}

function childEvidenceKey(report: ChildReportJson, evidenceId: string): string {
  return `${report.runId ?? 'child'}:${evidenceId}`
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))]
}
