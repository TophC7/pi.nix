// ## SHARD COORDINATOR ## //
// Schedules only queued QA shards through fresh subagent workers and keeps the
// durable shard-state artifact current. Non-queued shard states are left
// untouched by this coordinator pass.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { getQaParallelConfig, type QaParallelConfig } from './config.ts'
import {
  updateQaShardRunState,
  writeQaShardRunState,
  type QaShardPlan,
  type QaShardRunState,
  type QaShardSpec,
  type QaShardStateEntry,
  type QaShardStatus
} from './shards.ts'
import { clearPendingCapturesForRun } from './playwright-capture.ts'
import { clearActiveRun, type QaRunSpec } from './run-state.ts'
import { prepareQaShardWorker, runQaShardWorkerSubagents, type PreparedQaShardWorker } from './worker.ts'

export interface QaShardCoordinatorInput {
  readonly parentSpec: QaRunSpec
  readonly plan: QaShardPlan
  readonly state: QaShardRunState
  readonly parallel?: QaParallelConfig
  readonly runShardWorker?: (worker: PreparedQaShardWorker) => Promise<void>
}

export interface QaShardCoordinatorResult {
  readonly state: QaShardRunState
  readonly parallel: QaParallelConfig
  readonly completed: number
  readonly blocked: number
}

interface ShardWorkItem {
  readonly shard: QaShardSpec
  readonly state: QaShardStateEntry
}

interface ChildReportSummary {
  readonly status?: 'pass' | 'fail' | 'inconclusive'
  readonly reportPath?: string
  readonly reportJsonPath?: string
  readonly artifactPaths: readonly string[]
  readonly error?: string
}

export async function runQaShardCoordinator(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: QaShardCoordinatorInput
): Promise<QaShardCoordinatorResult> {
  const parallel = input.parallel ?? getQaParallelConfig()
  const concurrency = parallel.enabled ? parallel.maxConcurrency : 1
  let state = input.state
  const work = queuedWorkItems(input.plan, state)

  for (const batch of chunkWork(work, concurrency)) {
    const prepared = batch.map((item) => {
      state = updateQaShardRunState(state, item.shard.shardId, { status: 'running' })
      const latestEntry = state.shards.find((entry) => entry.shardId === item.shard.shardId) ?? item.state
      return { item, worker: prepareQaShardWorker({ parentSpec: input.parentSpec, shard: item.shard, state: latestEntry }) }
    })
    writeQaShardRunState(ctx.cwd, state)

    const failures = input.runShardWorker
      ? await runInjectedShardWorkerBatch(input.runShardWorker, prepared.map((entry) => entry.worker))
      : await runSubagentShardWorkerBatch(pi, ctx, input.parentSpec.runId, prepared.map((entry) => entry.worker))

    for (const { item, worker } of prepared) {
      const failure = failures.get(worker.childSpec.runId)
      const report = readChildReportSummary(ctx.cwd, worker.childSpec)
      const shardStatus = reportStatusToShardStatus(report.status)
      if (shardStatus === 'blocked') clearChildRun(worker.childSpec.runId)
      state = updateQaShardRunState(state, item.shard.shardId, {
        status: shardStatus,
        artifactPaths: report.artifactPaths,
        reportPath: report.reportPath,
        reportJsonPath: report.reportJsonPath
      })
      if (report.error) ctx.ui.notify(`/qa shard ${item.shard.shardId} report error: ${report.error}`, 'error')
      if (failure && shardStatus === 'blocked') ctx.ui.notify(`/qa shard ${item.shard.shardId} blocked: ${formatError(failure)}`, 'error')
    }
    writeQaShardRunState(ctx.cwd, state)
  }

  return {
    state,
    parallel,
    completed: state.shards.filter((shard) => isTerminalShardStatus(shard.status)).length,
    blocked: state.shards.filter((shard) => shard.status === 'blocked').length
  }
}

function chunkWork(work: readonly ShardWorkItem[], size: number): ShardWorkItem[][] {
  const chunks: ShardWorkItem[][] = []
  const chunkSize = Math.max(1, size)
  for (let index = 0; index < work.length; index += chunkSize) chunks.push(work.slice(index, index + chunkSize))
  return chunks
}

async function runInjectedShardWorkerBatch(
  runShardWorker: (worker: PreparedQaShardWorker) => Promise<void>,
  workers: readonly PreparedQaShardWorker[]
): Promise<Map<string, unknown>> {
  const failures = new Map<string, unknown>()
  await Promise.all(workers.map(async (worker) => {
    try {
      await runShardWorker(worker)
    } catch (error) {
      failures.set(worker.childSpec.runId, error)
    }
  }))
  return failures
}

async function runSubagentShardWorkerBatch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  parentRunId: string,
  workers: readonly PreparedQaShardWorker[]
): Promise<Map<string, unknown>> {
  try {
    await runQaShardWorkerSubagents(
      pi,
      ctx,
      workers,
      `/qa shards ${workers.map((worker) => worker.shard.shardId).join(', ')}`,
      `agentic-qa:${parentRunId}:shards`
    )
    return new Map()
  } catch (error) {
    return new Map(workers.map((worker) => [worker.childSpec.runId, error] as const))
  }
}

function clearChildRun(runId: string): void {
  clearPendingCapturesForRun(runId)
  clearActiveRun(runId)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function queuedWorkItems(plan: QaShardPlan, state: QaShardRunState): ShardWorkItem[] {
  const shardsById = new Map(plan.shards.map((shard) => [shard.shardId, shard]))
  return state.shards.flatMap((entry) => {
    if (entry.status !== 'queued') return []
    const shard = shardsById.get(entry.shardId)
    return shard ? [{ shard, state: entry }] : []
  })
}

function readChildReportSummary(cwd: string, spec: QaRunSpec): ChildReportSummary {
  const reportPath = `${spec.relativeRunDir}/report.md`
  const reportJsonPath = `${spec.relativeRunDir}/report.json`
  try {
    const parsed = JSON.parse(readFileSync(path.join(cwd, reportJsonPath), 'utf8')) as {
      status?: 'pass' | 'fail' | 'inconclusive'
      evidence?: Array<{ artifactPaths?: readonly string[]; bundledArtifactPaths?: readonly string[] }>
    }
    return {
      status: parsed.status,
      reportPath: existsSync(path.join(cwd, reportPath)) ? reportPath : undefined,
      reportJsonPath,
      artifactPaths: (parsed.evidence ?? []).flatMap((entry) => [...(entry.artifactPaths ?? []), ...(entry.bundledArtifactPaths ?? [])])
    }
  } catch (error) {
    if (isNotFoundError(error)) return { artifactPaths: [] }
    return { artifactPaths: [], reportJsonPath, error: `${reportJsonPath}: ${formatError(error)}` }
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function reportStatusToShardStatus(status: ChildReportSummary['status']): QaShardStatus {
  if (status === 'pass') return 'passed'
  if (status === 'fail') return 'failed'
  if (status === 'inconclusive') return 'inconclusive'
  return 'blocked'
}

function isTerminalShardStatus(status: QaShardStatus): boolean {
  return status === 'passed' || status === 'failed' || status === 'inconclusive' || status === 'blocked'
}
