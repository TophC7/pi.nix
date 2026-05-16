import type { Database } from 'bun:sqlite'
import { initReasoningSchema } from '../reasoning/schema.ts'

export const BUDDY_SCHEMA_VERSION = 1

const schemaSql = `
  CREATE TABLE IF NOT EXISTS companions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    species TEXT NOT NULL,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    mood TEXT DEFAULT 'happy',
    personality_bio TEXT DEFAULT '',
    user_id TEXT,
    stat_debugging INTEGER,
    stat_patience INTEGER,
    stat_chaos INTEGER,
    stat_wisdom INTEGER,
    stat_snark INTEGER,
    stat_points_available INTEGER DEFAULT 0,
    observer_mode TEXT DEFAULT 'both',
    guard_mode INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    companion_id TEXT,
    content TEXT NOT NULL,
    importance INTEGER DEFAULT 1,
    tag TEXT,
    metadata TEXT,
    is_consolidated INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(companion_id) REFERENCES companions(id)
  );

  CREATE TABLE IF NOT EXISTS xp_events (
    id TEXT PRIMARY KEY,
    companion_id TEXT,
    event_type TEXT NOT NULL,
    xp_gained INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(companion_id) REFERENCES companions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_xp_events_companion_type_created
    ON xp_events (companion_id, event_type, created_at);

  CREATE TABLE IF NOT EXISTS evolution_history (
    id TEXT PRIMARY KEY,
    companion_id TEXT,
    from_level INTEGER NOT NULL,
    to_level INTEGER NOT NULL,
    from_species TEXT NOT NULL,
    to_species TEXT NOT NULL,
    is_shiny INTEGER DEFAULT 0,
    is_mutation INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(companion_id) REFERENCES companions(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    companion_id TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    context_summary TEXT,
    FOREIGN KEY(companion_id) REFERENCES companions(id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL,
    text TEXT NOT NULL,
    eye_override TEXT,
    indicator TEXT,
    bubble_lines TEXT,
    expires_at INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(companion_id) REFERENCES companions(id)
  );
`

const companionColumnMigrations = [
  `ALTER TABLE companions ADD COLUMN observer_mode TEXT DEFAULT 'both'`,
  `ALTER TABLE companions ADD COLUMN stat_debugging INTEGER`,
  `ALTER TABLE companions ADD COLUMN stat_patience INTEGER`,
  `ALTER TABLE companions ADD COLUMN stat_chaos INTEGER`,
  `ALTER TABLE companions ADD COLUMN stat_wisdom INTEGER`,
  `ALTER TABLE companions ADD COLUMN stat_snark INTEGER`,
  `ALTER TABLE companions ADD COLUMN stat_points_available INTEGER DEFAULT 0`,
  `ALTER TABLE companions ADD COLUMN guard_mode INTEGER DEFAULT 0`
]

export function initBuddySchema(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(schemaSql)

  for (const migration of companionColumnMigrations) addColumnIfMissing(db, migration)

  initReasoningSchema(db)
  db.exec(`PRAGMA user_version = ${BUDDY_SCHEMA_VERSION}`)
}

function addColumnIfMissing(db: Database, sql: string): void {
  try {
    db.exec(sql)
  } catch (error) {
    if (isDuplicateColumnError(error)) return
    throw error
  }
}

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('duplicate column name')
}
