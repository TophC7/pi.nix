// ## MISSIONS ## //
// Colocated .qa.md discovery. Mission files stay near features; /qa and /qa:new
// use exact slugs. /qa:staged uses staged diff context instead of missions so a
// staged change drives the plan, not whichever .qa.md happens to be nearby.

import { closeSync, type Dirent, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { captureOptimizedCommand } from '../pi-lib/rtk.ts'
import { parseAgentFile } from '../pi-lib/subagents/discovery.ts'

const MISSION_SUFFIX = '.qa.md'
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', 'dist', 'build', 'result'])
const MAX_FRONTMATTER_BYTES = 64 * 1024
const MAX_STAGED_DIFF_BYTES = 160 * 1024

export interface QaGitRunner {
  exec: ExtensionAPI['exec']
}

export interface QaCommandContext {
  readonly cwd: ExtensionCommandContext['cwd']
  readonly signal?: ExtensionCommandContext['signal']
}

export interface QaMissionSummary {
  readonly slug: string
  readonly title?: string
  readonly filePath: string
  readonly relativePath: string
  readonly frontmatter: Readonly<Record<string, string>>
}

export interface QaMission extends QaMissionSummary {
  readonly body: string
}

export interface MissionLookupResult {
  readonly kind: 'found' | 'missing' | 'ambiguous'
  readonly mission?: QaMission
  readonly matches: readonly QaMissionSummary[]
  readonly available: readonly QaMissionSummary[]
}

export interface StagedQaContext {
  readonly stagedFiles: readonly string[]
  readonly stagedDiff: string
  readonly error?: string
}

export function discoverQaMissionSummaries(cwd: string): QaMissionSummary[] {
  return discoverMissionFiles(cwd).map((filePath) => readQaMissionSummary(cwd, filePath))
}

export function discoverQaMissions(cwd: string): QaMission[] {
  return discoverMissionFiles(cwd).map((filePath) => parseQaMission(cwd, filePath))
}

export function loadQaMission(cwd: string, mission: QaMissionSummary): QaMission {
  return parseQaMission(cwd, mission.filePath)
}

export function lookupQaMission(cwd: string, slug: string): MissionLookupResult {
  const available = discoverQaMissionSummaries(cwd)
  const matches = available.filter((mission) => mission.slug === slug)
  if (matches.length === 1) {
    return { kind: 'found', mission: parseQaMission(cwd, matches[0].filePath), matches, available }
  }
  if (matches.length > 1) return { kind: 'ambiguous', matches, available }
  return { kind: 'missing', matches, available }
}

export async function collectStagedQaContext(pi: QaGitRunner, ctx: QaCommandContext): Promise<StagedQaContext> {
  const [staged, diff] = await Promise.all([getStagedFiles(pi, ctx), getStagedDiff(pi, ctx)])
  if (staged.error) return { stagedFiles: staged.files, stagedDiff: '', error: staged.error }
  return {
    stagedFiles: staged.files,
    stagedDiff: diff.output,
    ...(diff.error ? { error: diff.error } : {})
  }
}

export function formatMissionList(missions: readonly QaMissionSummary[]): string {
  if (missions.length === 0) return 'No .qa.md missions found.'
  return missions
    .map((mission) => `- ${mission.slug}${mission.title ? ` — ${mission.title}` : ''} (${mission.relativePath})`)
    .join('\n')
}

function discoverMissionFiles(cwd: string): string[] {
  const results: string[] = []
  walk(cwd, results)
  return results.sort((left, right) => left.localeCompare(right))
}

function walk(dir: string, results: string[]): void {
  for (const entry of safeReadDir(dir)) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(fullPath, results)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(MISSION_SUFFIX)) results.push(fullPath)
  }
}

function parseQaMission(cwd: string, filePath: string): QaMission {
  const raw = readFileSync(filePath, 'utf8')
  const parsed = parseAgentFile(raw)
  const frontmatter = parsed?.frontmatter ?? {}
  const body = parsed?.systemPrompt ?? raw.replace(/\r\n/g, '\n')
  const fallbackSlug = path.basename(filePath, MISSION_SUFFIX)
  const slug = frontmatter.slug?.trim() || fallbackSlug
  const title = frontmatter.title?.trim() || undefined
  return {
    slug,
    title,
    filePath,
    relativePath: path.relative(cwd, filePath),
    body: body.trim(),
    frontmatter
  }
}

function readQaMissionSummary(cwd: string, filePath: string): QaMissionSummary {
  const parsed = parseAgentFile(readFrontmatterChunk(filePath))
  const frontmatter = parsed?.frontmatter ?? {}
  const fallbackSlug = path.basename(filePath, MISSION_SUFFIX)
  return {
    slug: frontmatter.slug?.trim() || fallbackSlug,
    title: frontmatter.title?.trim() || undefined,
    filePath,
    relativePath: path.relative(cwd, filePath),
    frontmatter
  }
}

function readFrontmatterChunk(filePath: string): string {
  const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES)
  const fd = openSync(filePath, 'r')
  try {
    const bytesRead = readSync(fd, buffer, 0, MAX_FRONTMATTER_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

async function getStagedFiles(pi: QaGitRunner, ctx: QaCommandContext): Promise<{ readonly files: string[]; readonly error?: string }> {
  const result = await runGit(pi, ctx, ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  return {
    files: result.output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    ...(result.error ? { error: result.error } : {})
  }
}

async function getStagedDiff(pi: QaGitRunner, ctx: QaCommandContext): Promise<{ readonly output: string; readonly error?: string }> {
  const capture = await captureOptimizedCommand(pi, 'git diff --staged', { cwd: ctx.cwd, signal: ctx.signal, maxBytes: MAX_STAGED_DIFF_BYTES })
  return {
    output: capture.output.trim() || '<no staged diff>',
    ...(capture.error ? { error: capture.error } : {})
  }
}

async function runGit(
  pi: QaGitRunner,
  ctx: QaCommandContext,
  args: readonly string[]
): Promise<{ readonly output: string; readonly error?: string }> {
  const result = await pi.exec('git', [...args], { cwd: ctx.cwd, signal: ctx.signal })
  if (result.code === 0) return { output: result.stdout }
  return { output: '', error: `git ${args.join(' ')} failed: ${result.stderr || `exit ${result.code}`}` }
}

function safeReadDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
