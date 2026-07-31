import type { Database } from 'bun:sqlite'
import { REASONING_CONFIG } from './config.ts'
import { runAllDetectors } from './detectors.ts'
import { selectFindingDetailed, logFinding } from './findings.ts'
import { loadSessionGraph } from './graph.ts'
import { resolveProjectRoot, type ResolvedRoot } from './project-root.ts'
import { pruneOldSessionsThrottled } from './retention.ts'
import { deriveSessionId } from './session.ts'
import type { Finding, StoredClaim } from './types.ts'
import { loadRecentClaims, writeClaims, type WriteResult } from './writer.ts'

export interface PipelineInputs {
  readonly companionId: string
  readonly cwd?: string | null
  readonly claims?: unknown
  readonly edges?: unknown
}
export interface PipelineOutputs {
  readonly sessionId: string
  readonly resolvedRoot: ResolvedRoot
  readonly writeResult: WriteResult
  readonly finding: Finding | null
  readonly extractionInstruction: string
  readonly detectorMs: number
  readonly budgetExceeded: boolean
  readonly recentClaims: readonly StoredClaim[]
  readonly suppression: 'no_candidates' | 'cooldown' | 'budget' | null
}
export interface PipelineOptions {
  readonly detectorBudgetMs?: number
  readonly now?: () => number
  readonly measureDetectorMs?: <T>(fn: () => T) => { value: T; ms: number }
}

export function runGuardPipeline(db: Database, inputs: PipelineInputs, options: PipelineOptions = {}): PipelineOutputs {
  const now = options.now?.() ?? Date.now()
  pruneOldSessionsThrottled(db, now)
  const resolvedRoot = resolveProjectRoot(inputs.cwd)
  const sessionId = deriveSessionId(resolvedRoot.path, now)
  const seq = bumpObserveSeq(db, inputs.companionId, Array.isArray(inputs.claims) && inputs.claims.length > 0)
  const writeResult = writeClaims(db, sessionId, inputs.claims, inputs.edges)
  const graph = loadSessionGraph(db, sessionId)
  const budget = options.detectorBudgetMs ?? REASONING_CONFIG.DETECTOR_BUDGET_MS
  const measured = (options.measureDetectorMs ?? defaultMeasure)(() => runAllDetectors(graph))
  const recentClaims = loadRecentClaims(db, sessionId)
  const extractionInstruction = buildExtractionInstruction(recentClaims)
  if (measured.ms > budget)
    return {
      sessionId,
      resolvedRoot,
      writeResult,
      finding: null,
      extractionInstruction,
      detectorMs: measured.ms,
      budgetExceeded: true,
      recentClaims,
      suppression: 'budget'
    }
  const selection = selectFindingDetailed(db, inputs.companionId, seq, measured.value)
  if (selection.finding) logFinding(db, inputs.companionId, sessionId, seq, selection.finding)
  return {
    sessionId,
    resolvedRoot,
    writeResult,
    finding: selection.finding,
    extractionInstruction,
    detectorMs: measured.ms,
    budgetExceeded: false,
    recentClaims,
    suppression: selection.suppression
  }
}

function defaultMeasure<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

function bumpObserveSeq(db: Database, companionId: string, claimsReceived: boolean): number {
  db.query(
    'INSERT OR IGNORE INTO reasoning_observe_seq (companion_id, seq, last_claims_received_seq) VALUES (?, 0, 0)'
  ).run(companionId)
  db.query('UPDATE reasoning_observe_seq SET seq = seq + 1 WHERE companion_id = ?').run(companionId)
  if (claimsReceived)
    db.query('UPDATE reasoning_observe_seq SET last_claims_received_seq = seq WHERE companion_id = ?').run(companionId)
  const row = db.query('SELECT seq FROM reasoning_observe_seq WHERE companion_id = ?').get(companionId) as {
    seq?: number
  } | null
  return row?.seq ?? 1
}

function buildExtractionInstruction(recentClaims: readonly StoredClaim[]): string {
  const context = recentClaims
    .map(
      (claim) =>
        '- ' +
        claim.id.slice(0, 8) +
        ' [' +
        claim.speaker +
        '/' +
        claim.basis +
        '/' +
        claim.confidence +
        '] ' +
        claim.text
    )
    .join('\n')
  return [
    'Guard mode: when calling buddy_observe, include claims and edges from this turn when available.',
    'Claims require text, basis, speaker, confidence, and external_id. Edges use from/to external IDs or prior claim UUID prefixes plus supports/depends_on/contradicts/questions.',
    context ? 'Recent claims for edge references:\n' + context : ''
  ]
    .filter(Boolean)
    .join('\n')
}
