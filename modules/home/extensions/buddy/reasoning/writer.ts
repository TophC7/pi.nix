import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { REASONING_CONFIG } from './config.ts'
import { isBasis, isConfidence, isEdgeType, isSpeaker, type ClaimInput, type EdgeInput, type StoredClaim } from './types.ts'

export interface WriteResult { readonly claimsWritten: number; readonly edgesWritten: number; readonly claimsDropped: number; readonly edgesDropped: number }

export function writeClaims(db: Database, sessionId: string, claims: unknown, edges: unknown): WriteResult {
  const claimInputs = parseClaims(claims)
  const edgeInputs = parseEdges(edges)
  const externalToId = new Map<string, string>()
  let claimsWritten = 0, edgesWritten = 0, edgesDropped = 0
  const now = Date.now()
  for (const claim of claimInputs) {
    const id = randomUUID()
    externalToId.set(claim.external_id, id)
    db.query('INSERT INTO reasoning_claims (id, session_id, speaker, text, basis, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, claim.speaker, sanitizeClaim(claim.text), claim.basis, claim.confidence, now)
    claimsWritten++
  }
  for (const edge of edgeInputs) {
    const from = resolveEndpoint(db, sessionId, edge.from, externalToId)
    const to = resolveEndpoint(db, sessionId, edge.to, externalToId)
    if (!from || !to) { edgesDropped++; continue }
    db.query('INSERT INTO reasoning_edges (id, session_id, from_claim, to_claim, type, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), sessionId, from, to, edge.type, now)
    edgesWritten++
  }
  const claimsDropped = Array.isArray(claims) ? claims.length - claimInputs.length : 0
  edgesDropped += Array.isArray(edges) ? edges.length - edgeInputs.length : 0
  pruneClaimOverflow(db, sessionId)
  return { claimsWritten, edgesWritten, claimsDropped, edgesDropped }
}

export function loadRecentClaims(db: Database, sessionId: string, limit = REASONING_CONFIG.RECENT_CLAIMS_CONTEXT): StoredClaim[] {
  return db.query('SELECT * FROM reasoning_claims WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, limit) as StoredClaim[]
}

function parseClaims(value: unknown): ClaimInput[] {
  if (!Array.isArray(value)) return []
  const out: ClaimInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.text !== 'string' || !record.text.trim()) continue
    if (!isBasis(record.basis) || !isSpeaker(record.speaker) || !isConfidence(record.confidence)) continue
    if (typeof record.external_id !== 'string' || !record.external_id.trim()) continue
    out.push({ text: record.text, basis: record.basis, speaker: record.speaker, confidence: record.confidence, external_id: record.external_id })
  }
  return out
}

function parseEdges(value: unknown): EdgeInput[] {
  if (!Array.isArray(value)) return []
  const out: EdgeInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.from !== 'string' || typeof record.to !== 'string' || !isEdgeType(record.type)) continue
    out.push({ from: record.from, to: record.to, type: record.type })
  }
  return out
}

function resolveEndpoint(db: Database, sessionId: string, ref: string, externalToId: Map<string, string>): string | null {
  if (externalToId.has(ref)) return externalToId.get(ref)!
  const row = db.query('SELECT id FROM reasoning_claims WHERE session_id = ? AND (id = ? OR substr(id, 1, 8) = ?) LIMIT 1').get(sessionId, ref, ref.toLowerCase()) as { id: string } | null
  return row?.id ?? null
}

function sanitizeClaim(text: string): string {
  return text.replace(/[\p{Cf}\p{Cc}\p{Co}]/gu, '').replace(/[{}$]/g, '').trim().slice(0, REASONING_CONFIG.MAX_CLAIM_TEXT_LENGTH)
}

function pruneClaimOverflow(db: Database, sessionId: string): void {
  const staleClaims = `
    SELECT id FROM reasoning_claims
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT -1 OFFSET ?
  `
  db.query(`
    DELETE FROM reasoning_edges
    WHERE session_id = ?
      AND (from_claim IN (${staleClaims}) OR to_claim IN (${staleClaims}))
  `).run(sessionId, sessionId, REASONING_CONFIG.MAX_CLAIMS_PER_SESSION, sessionId, REASONING_CONFIG.MAX_CLAIMS_PER_SESSION)
  db.query(`DELETE FROM reasoning_claims WHERE id IN (${staleClaims})`).run(sessionId, REASONING_CONFIG.MAX_CLAIMS_PER_SESSION)
}

