import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface BuddyStatePathOptions {
  readonly homeDir?: string
  readonly stateDir?: string
  readonly dbPath?: string
}

export interface BuddyStatePaths {
  readonly stateDir: string
  readonly dbPath: string
}

export function resolveBuddyStatePaths(options: BuddyStatePathOptions = {}): BuddyStatePaths {
  const requestedDbPath = options.dbPath ? resolve(options.dbPath) : undefined
  const defaultStateDir = join(options.homeDir ?? homedir(), '.pi', 'agent', 'state', 'buddy')
  const stateDir = resolve(options.stateDir ?? (requestedDbPath ? dirname(requestedDbPath) : defaultStateDir))
  const dbPath = requestedDbPath ?? join(stateDir, 'buddy.db')

  return { stateDir, dbPath }
}

export function ensureBuddyStateDir(paths: BuddyStatePaths = resolveBuddyStatePaths()): BuddyStatePaths {
  mkdirSync(paths.stateDir, { recursive: true })
  return paths
}
