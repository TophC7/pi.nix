// ## FILES ## //
// Filesystem layer for sdd specs. All specs live at .sworm/sdd/<slug>.md.
// Writes go through one helper that hash-compares against the prior content to
// clear `verified` when the spec materially changes.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { emptySpec, hashContent, parseSpec, serializeSpec, type Spec, type SpecStatus } from './parser.ts'

export const SPEC_ROOT = '.sworm/sdd'
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export interface SpecListing {
  slug: string
  title: string
  status: SpecStatus
  path: string
  modifiedAt: Date
}

export class SpecPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecPathError'
  }
}

export function specPath(cwd: string, slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new SpecPathError(`Invalid spec slug "${slug}". Use lowercase letters, digits, and hyphens.`)
  }
  const root = resolve(cwd, SPEC_ROOT)
  const full = resolve(root, `${slug}.md`)
  const rel = relative(root, full)
  if (rel.startsWith('..') || rel === '' || rel.includes('..')) {
    throw new SpecPathError(`Spec path escapes ${SPEC_ROOT}.`)
  }
  return full
}

export function specExists(cwd: string, slug: string): boolean {
  try {
    return existsSync(specPath(cwd, slug))
  } catch {
    return false
  }
}

export function readSpec(cwd: string, slug: string): Spec | undefined {
  if (!specExists(cwd, slug)) return undefined
  const content = readFileSync(specPath(cwd, slug), 'utf8')
  return parseSpec(content)
}

export interface WriteSpecResult {
  path: string
  clearedVerified: boolean
}

export function writeSpec(cwd: string, slug: string, spec: Spec): WriteSpecResult {
  const path = specPath(cwd, slug)
  // NOTE: clearing `verified` is content-driven. If the next serialization
  // differs from the prior hash AND the spec was previously verified, demote
  // back to draft so /spec:check has to revalidate after material changes.
  const next: Spec = { ...spec }
  const candidate = serializeSpec(next)
  const candidateHash = hashContent(candidate)
  let clearedVerified = false
  if (next.frontmatter.status === 'verified' && spec.hash && spec.hash !== candidateHash) {
    next.frontmatter = { ...next.frontmatter, status: 'draft', verifiedAt: undefined }
    clearedVerified = true
  }
  const finalContent = clearedVerified ? serializeSpec(next) : candidate
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, finalContent)
  return { path, clearedVerified }
}

export function writeNewSpec(cwd: string, slug: string, title: string): WriteSpecResult {
  const path = specPath(cwd, slug)
  if (existsSync(path)) throw new SpecPathError(`Spec already exists: ${slugFromPath(path)}.`)
  return writeSpec(cwd, slug, emptySpec(title))
}

export function listSpecs(cwd: string): SpecListing[] {
  const root = join(cwd, SPEC_ROOT)
  if (!existsSync(root)) return []
  const entries: SpecListing[] = []
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.md')) continue
    const slug = name.slice(0, -3)
    if (!SLUG_RE.test(slug)) continue
    const path = join(root, name)
    try {
      const stat = statSync(path)
      const spec = parseSpec(readFileSync(path, 'utf8'))
      entries.push({
        slug,
        title: spec.frontmatter.title,
        status: spec.frontmatter.status,
        path,
        modifiedAt: stat.mtime
      })
    } catch {
      // skip malformed specs from the picker; user can fix manually
      continue
    }
  }
  return entries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
}

export function slugFromPath(path: string): string {
  const base = path.split('/').pop() ?? ''
  return base.replace(/\.md$/, '')
}
