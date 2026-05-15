import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface ResolvedRoot {
  readonly path: string
  readonly source: 'hint' | 'env' | 'marker' | 'homedir' | 'cwd'
  readonly markerFound?: string
  readonly envVar?: string
}

const ENV_CANDIDATES = ['PI_PROJECT_DIR', 'PROJECT_ROOT', 'WORKSPACE_FOLDER', 'INIT_CWD'] as const
const MARKERS = ['.git', 'flake.nix', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pom.xml'] as const

export function resolveProjectRoot(hint?: string | null): ResolvedRoot {
  if (isValidAbsoluteDir(hint)) return { path: resolve(hint), source: 'hint' }
  for (const envVar of ENV_CANDIDATES) {
    const value = process.env[envVar]
    if (isValidAbsoluteDir(value)) return { path: resolve(value), source: 'env', envVar }
  }

  const cwd = process.cwd()
  const marker = findMarker(cwd)
  if (marker) return { path: marker.root, source: 'marker', markerFound: marker.marker }
  return { path: resolve(cwd), source: cwd === homedir() ? 'homedir' : 'cwd' }
}

function isValidAbsoluteDir(value: unknown): value is string {
  if (typeof value !== 'string' || !isAbsolute(value)) return false
  try { return statSync(value).isDirectory() } catch { return false }
}

function findMarker(start: string): { root: string; marker: string } | null {
  let dir = resolve(start)
  const seen = new Set<string>()
  while (!seen.has(dir)) {
    seen.add(dir)
    for (const marker of MARKERS) {
      if (existsSync(resolve(dir, marker))) return { root: dir, marker }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

