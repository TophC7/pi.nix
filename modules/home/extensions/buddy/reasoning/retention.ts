import type { Database } from 'bun:sqlite'
import { REASONING_CONFIG } from './config.ts'
import { sessionDayStartMs } from './session.ts'

export type PurgeScope = 'session' | 'all'
export interface PurgeResult {
  readonly claims: number
  readonly edges: number
  readonly findings: number
}

const PRUNE_THROTTLE_MS = 60 * 60 * 1000
let lastPruneMs = 0

export function pruneOldSessionsThrottled(db: Database, nowMs = Date.now()): PurgeResult {
  if (nowMs - lastPruneMs < PRUNE_THROTTLE_MS) return { claims: 0, edges: 0, findings: 0 }
  lastPruneMs = nowMs
  return pruneOldSessions(db, nowMs)
}

export function pruneOldSessions(db: Database, nowMs = Date.now()): PurgeResult {
  const cutoff = nowMs - REASONING_CONFIG.SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const sessions = db.query('SELECT DISTINCT session_id FROM reasoning_claims').all() as Array<{ session_id: string }>
  const stale = sessions
    .map((row) => row.session_id)
    .filter((id) => {
      const start = sessionDayStartMs(id)
      return start !== null && start < cutoff
    })
  return purgeSessions(db, stale)
}

export function purgeReasoning(db: Database, scope: PurgeScope, sessionId?: string): PurgeResult {
  return scope === 'session' ? purgeSessions(db, sessionId ? [sessionId] : []) : purgeAll(db)
}

function purgeSessions(db: Database, sessionIds: readonly string[]): PurgeResult {
  let claims = 0,
    edges = 0,
    findings = 0
  for (const id of sessionIds) {
    claims += db.query('DELETE FROM reasoning_claims WHERE session_id = ?').run(id).changes
    edges += db.query('DELETE FROM reasoning_edges WHERE session_id = ?').run(id).changes
    findings += db.query('DELETE FROM reasoning_findings_log WHERE session_id = ?').run(id).changes
  }
  return { claims, edges, findings }
}

function purgeAll(db: Database): PurgeResult {
  const claims = db.query('DELETE FROM reasoning_claims').run().changes
  const edges = db.query('DELETE FROM reasoning_edges').run().changes
  const findings = db.query('DELETE FROM reasoning_findings_log').run().changes
  db.query('DELETE FROM reasoning_observe_seq').run()
  return { claims, edges, findings }
}
