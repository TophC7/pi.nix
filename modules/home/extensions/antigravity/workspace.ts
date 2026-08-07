import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function removeAgyWorkspace(workspace?: string): void {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
}

export function prepareAgyWorkspace(
  sessionId: string,
  cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
): string {
  const workspace = join(cacheRoot, 'pi', 'antigravity', 'workspaces', encodeURIComponent(sessionId))
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  return realpathSync(workspace)
}
