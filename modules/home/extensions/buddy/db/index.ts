import type { Database as BunDatabase } from 'bun:sqlite'
import { ensureBuddyStateDir, resolveBuddyStatePaths, type BuddyStatePathOptions, type BuddyStatePaths } from './paths.ts'
import { initBuddySchema } from './schema.ts'

declare const require: ((id: string) => unknown) | undefined

type DatabaseConstructor = new (path: string, options?: { readonly?: boolean; readwrite?: boolean; create?: boolean }) => BunDatabase

export interface BuddyDatabaseState {
  readonly db: BunDatabase
  readonly paths: BuddyStatePaths
}

let runtimeState: BuddyDatabaseState | undefined
let databaseConstructor: DatabaseConstructor | undefined

export function assertBunSqliteAvailable(): void {
  const Database = loadBunSqliteDatabase()
  let smoke: BunDatabase | undefined

  try {
    smoke = new Database(':memory:')
    const row = smoke.query('SELECT 1 AS ok').get() as { ok?: number } | null
    if (row?.ok !== 1) throw new Error('Buddy SQLite smoke query returned an unexpected result')
  } catch (error) {
    throw new Error('Buddy requires the Pi command to run under Bun with SQLite enabled: ' + formatError(error))
  } finally {
    smoke?.close()
  }
}

export function openBuddyDatabase(options: BuddyStatePathOptions = {}): BuddyDatabaseState {
  const Database = loadBunSqliteDatabase()
  const paths = ensureBuddyStateDir(resolveBuddyStatePaths(options))
  const db = new Database(paths.dbPath, { create: true })
  return { db, paths }
}

export function openInitializedBuddyDatabase(options: BuddyStatePathOptions = {}): BuddyDatabaseState {
  const state = openBuddyDatabase(options)
  initBuddySchema(state.db)
  return state
}

export function getBuddyDatabase(): BuddyDatabaseState {
  if (!runtimeState) {
    assertBunSqliteAvailable()
    runtimeState = openInitializedBuddyDatabase()
  }

  return runtimeState
}

export function closeBuddyDatabase(): void {
  runtimeState?.db.close()
  runtimeState = undefined
}

function loadBunSqliteDatabase(): DatabaseConstructor {
  if (databaseConstructor) return databaseConstructor

  try {
    const requireFn = getRequire()
    if (!requireFn) throw new Error('CommonJS require is unavailable')
    const module = requireFn('bun:sqlite') as { Database?: DatabaseConstructor }
    if (typeof module.Database !== 'function') throw new Error('bun:sqlite did not expose Database')
    databaseConstructor = module.Database
    return databaseConstructor
  } catch (error) {
    throw new Error('Buddy requires the Pi command to run under Bun; bun:sqlite is unavailable in this runtime: ' + formatError(error))
  }
}

function getRequire(): ((id: string) => unknown) | undefined {
  try {
    if (typeof require === 'function') return require
  } catch {
    // ignored: ESM runtimes may not define require.
  }

  try {
    return (0, eval)('typeof require === "function" ? require : undefined') as ((id: string) => unknown) | undefined
  } catch {
    return undefined
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { resolveBuddyStatePaths, ensureBuddyStateDir }
export type { BuddyStatePathOptions, BuddyStatePaths }

