import type { Database } from 'bun:sqlite'
import { deriveSessionId } from './session.ts'
import { resolveProjectRoot } from './project-root.ts'

export interface ReasoningStatus {
  readonly guardMode: boolean
  readonly sessionId: string
  readonly workspace: string
  readonly workspaceSource: string
  readonly claims: number
  readonly edges: number
  readonly findings: number
  readonly observeSeq: number
}

export function getReasoningStatus(
  db: Database,
  companionId: string,
  guardMode: boolean,
  cwd?: string | null
): ReasoningStatus {
  const root = resolveProjectRoot(cwd)
  const sessionId = deriveSessionId(root.path)
  const claims = count(db, 'reasoning_claims', sessionId)
  const edges = count(db, 'reasoning_edges', sessionId)
  const findings =
    (
      db.query('SELECT count(*) AS n FROM reasoning_findings_log WHERE companion_id = ?').get(companionId) as {
        n?: number
      } | null
    )?.n ?? 0
  const seq =
    (
      db.query('SELECT seq FROM reasoning_observe_seq WHERE companion_id = ?').get(companionId) as {
        seq?: number
      } | null
    )?.seq ?? 0
  return {
    guardMode,
    sessionId,
    workspace: root.path,
    workspaceSource: root.source,
    claims,
    edges,
    findings,
    observeSeq: seq
  }
}

function count(db: Database, table: string, sessionId: string): number {
  return (
    (db.query('SELECT count(*) AS n FROM ' + table + ' WHERE session_id = ?').get(sessionId) as { n?: number } | null)
      ?.n ?? 0
  )
}
