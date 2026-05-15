import { createHash } from 'node:crypto'

const HASH_LEN = 16

export function deriveSessionId(workspacePath: string, nowMs = Date.now()): string {
  const day = new Date(nowMs).toISOString().slice(0, 10)
  const hash = createHash('sha256').update(workspacePath).digest('hex').slice(0, HASH_LEN)
  return day + ':' + hash
}

export function sessionDayStartMs(sessionId: string): number | null {
  const day = sessionId.slice(0, 10)
  const ms = Date.parse(day + 'T00:00:00.000Z')
  return Number.isFinite(ms) ? ms : null
}

