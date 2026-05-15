import type { Database } from 'bun:sqlite'
import { REASONING_CONFIG } from './config.ts'
import type { Finding, FindingType } from './types.ts'
import { isCaution } from './types.ts'

interface RecentFinding { readonly finding_type: FindingType; readonly anchor_claim_id: string; readonly observe_seq: number }
export interface SelectionResult { readonly finding: Finding | null; readonly suppression: 'no_candidates' | 'cooldown' | null }

export function selectFindingDetailed(db: Database, companionId: string, currentSeq: number, candidates: readonly Finding[]): SelectionResult {
  if (candidates.length === 0) return { finding: null, suppression: 'no_candidates' }
  const window = Math.max(REASONING_CONFIG.CAUTION_COOLDOWN_OBSERVES, REASONING_CONFIG.KUDOS_COOLDOWN_OBSERVES, REASONING_CONFIG.KUDOS_BIAS_WINDOW)
  const recent = db.query('SELECT finding_type, anchor_claim_id, observe_seq FROM reasoning_findings_log WHERE companion_id = ? AND observe_seq > ? ORDER BY observe_seq DESC').all(companionId, currentSeq - window) as RecentFinding[]
  const eligible = candidates.filter((candidate) => !isOnCooldown(candidate, recent, currentSeq))
  if (eligible.length === 0) return { finding: null, suppression: 'cooldown' }
  const caution = eligible.filter((candidate) => isCaution(candidate.type))
  const kudos = eligible.filter((candidate) => !isCaution(candidate.type))
  const recentCaution = recent.filter((item) => currentSeq - item.observe_seq < REASONING_CONFIG.KUDOS_BIAS_WINDOW && isCaution(item.finding_type)).length
  const recentKudos = recent.filter((item) => currentSeq - item.observe_seq < REASONING_CONFIG.KUDOS_BIAS_WINDOW && !isCaution(item.finding_type)).length
  if (kudos.length > 0 && recentCaution >= REASONING_CONFIG.KUDOS_BIAS_CAUTION_THRESHOLD && recentKudos === 0) return { finding: kudos[0]!, suppression: null }
  if (caution.length > 0 && kudos.length > 0) return { finding: ((currentSeq * 37) % 100) / 100 < REASONING_CONFIG.KUDOS_TIE_BREAK_WEIGHT ? kudos[0]! : caution[0]!, suppression: null }
  return { finding: eligible[0]!, suppression: null }
}

export function logFinding(db: Database, companionId: string, sessionId: string, observeSeq: number, finding: Finding): void {
  db.query('INSERT INTO reasoning_findings_log (companion_id, session_id, finding_type, anchor_claim_id, observe_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(companionId, sessionId, finding.type, finding.anchor_claim_id, observeSeq, Date.now())
}

function isOnCooldown(finding: Finding, recent: readonly RecentFinding[], currentSeq: number): boolean {
  const cooldown = isCaution(finding.type) ? REASONING_CONFIG.CAUTION_COOLDOWN_OBSERVES : REASONING_CONFIG.KUDOS_COOLDOWN_OBSERVES
  return recent.some((item) => item.anchor_claim_id === finding.anchor_claim_id && currentSeq - item.observe_seq < cooldown)
}

