import type { Database } from 'bun:sqlite'
import { getCompanion, getPrimaryCompanionRow } from '../core/companion.ts'
import type { Companion } from '../core/types.ts'

export function parseGuardFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', 'on', '1', 'yes', 'guard'].includes(normalized)) return true
  if (['false', 'off', '0', 'no'].includes(normalized)) return false
  return undefined
}

export function setGuardMode(db: Database, enabled: boolean): Companion {
  const row = getPrimaryCompanionRow(db)
  if (!row) throw new Error('Hatch a companion first')
  db.query('UPDATE companions SET guard_mode = ? WHERE id = ?').run(enabled ? 1 : 0, row.id)
  return getCompanion(db)!
}

export function formatModeResponse(companion: Companion): string {
  return 'Buddy voice mode: ' + companion.observerMode + '. Guard mode: ' + (companion.guardMode ? 'on' : 'off') + '.'
}

