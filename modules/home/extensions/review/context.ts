import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { headBytes } from '@pi/lib/subagents/output'

const MAX_CONTEXT_BYTES = 360 * 1024
const MAX_SECTION_BYTES = 120 * 1024
const MAX_FILE_BYTES = 80 * 1024
export const MAX_DIFF_BYTES = 220 * 1024

const CONVENTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  '.editorconfig',
  '.gitignore',
  'CONTRIBUTING.md',
  'STYLE.md'
] as const

const COMMENT_GUIDANCE_FILES = [
  'COMMENT_STYLE.md',
  'COMMENTS.md',
  'docs/comment-style.md',
  'docs/comments.md',
  'docs/style.md'
] as const

export interface ReviewContextCapture {
  content: string
  files: readonly string[]
  notes: readonly string[]
  truncated: boolean
}

export function captureStagedReviewContext(
  ctx: ExtensionCommandContext,
  args: {
    diff: string
    files: readonly string[]
    guidance?: string
    notes?: readonly string[]
  }
): ReviewContextCapture {
  const files = args.files
  const builder = createContextBuilder()

  builder.add('Target', 'staged changes')
  builder.add('User guidance', args.guidance || '<none>')
  builder.add('Staged files', files.length ? files.join('\n') : '<none>')
  for (const note of args.notes ?? []) builder.note(note)

  for (const path of existingUniqueFiles(ctx.cwd, CONVENTION_FILES)) {
    builder.addFile(`Project convention: ${path}`, path, ctx.cwd)
  }

  const manifestCandidates = manifestsFor(files)
  for (const path of existingUniqueFiles(ctx.cwd, manifestCandidates)) {
    builder.addFile(`Manifest/config: ${path}`, path, ctx.cwd)
  }
  for (const note of missingManifestNotes(ctx.cwd, files)) builder.note(note)

  for (const path of existingUniqueFiles(ctx.cwd, COMMENT_GUIDANCE_FILES)) {
    builder.addFile(`Comment guidance: ${path}`, path, ctx.cwd)
  }

  builder.add('Staged diff', args.diff, MAX_DIFF_BYTES)

  return { ...builder.finish(), files }
}

export function captureFreehandReviewContext(
  ctx: ExtensionCommandContext,
  args: { prompt: string }
): ReviewContextCapture {
  const files = extractPromptFiles(args.prompt, ctx.cwd)
  const builder = createContextBuilder()

  builder.add('Target', 'freehand prompt')
  builder.add('User prompt', args.prompt)
  builder.add('Prompt-mentioned files', files.length ? files.join('\n') : '<none detected>')

  for (const path of existingUniqueFiles(ctx.cwd, CONVENTION_FILES)) {
    builder.addFile(`Project convention: ${path}`, path, ctx.cwd)
  }

  for (const path of existingUniqueFiles(ctx.cwd, manifestsFor(files))) {
    builder.addFile(`Manifest/config: ${path}`, path, ctx.cwd)
  }
  for (const note of missingManifestNotes(ctx.cwd, files)) builder.note(note)

  for (const path of files) {
    builder.addFile(`Prompt-mentioned file: ${path}`, path, ctx.cwd)
  }

  for (const path of existingUniqueFiles(ctx.cwd, COMMENT_GUIDANCE_FILES)) {
    builder.addFile(`Comment guidance: ${path}`, path, ctx.cwd)
  }

  return { ...builder.finish(), files }
}

export function splitZ(raw: string): string[] {
  return raw
    .split('\0')
    .map((part) => part.trim())
    .filter(Boolean)
}

function manifestsFor(files: readonly string[]): string[] {
  const out = new Set<string>()
  const add = (...paths: string[]) => paths.forEach((path) => out.add(path))
  const hasExt = (...extensions: string[]) => files.some((file) => extensions.some((ext) => file.endsWith(ext)))
  const hasName = (...names: string[]) => files.some((file) => names.some((name) => file.endsWith(name)))

  if (hasExt('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.vue') || hasName('package.json')) {
    add(
      'package.json',
      'bun.lock',
      'bun.lockb',
      'bunfig.toml',
      'tsconfig.json',
      'jsconfig.json',
      'vite.config.ts',
      'vite.config.js',
      'svelte.config.js',
      'next.config.js',
      'eslint.config.js',
      'biome.json'
    )
  }

  if (hasExt('.nix') || hasName('flake.nix')) add('flake.nix', 'default.nix', 'shell.nix')
  if (hasExt('.rs') || hasName('Cargo.toml')) add('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml')
  if (hasExt('.go') || hasName('go.mod')) add('go.mod', 'go.sum')
  if (hasExt('.py') || hasName('pyproject.toml')) add('pyproject.toml', 'uv.lock', 'requirements.txt', 'setup.cfg')
  if (hasExt('.sql')) add('schema.sql', 'drizzle.config.ts', 'prisma/schema.prisma')

  return [...out]
}

function missingManifestNotes(cwd: string, files: readonly string[]): string[] {
  const notes: string[] = []
  const jsLike = files.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue)$/.test(file))
  if (jsLike && !existsSync(join(cwd, 'package.json'))) {
    notes.push(
      'No package.json found at repo root despite staged JS/TS-like files; reviewers must not assume npm scripts or dependencies.'
    )
  }
  if (jsLike && !existsSync(join(cwd, 'tsconfig.json'))) {
    notes.push(
      'No tsconfig.json found at repo root despite staged TS-like files; reviewers must verify TypeScript assumptions from local context.'
    )
  }
  return notes
}

function existingUniqueFiles(cwd: string, paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    const full = join(cwd, path)
    try {
      if (statSync(full).isFile()) out.push(path)
    } catch {
      // Ignore missing files or files that disappear before stat.
    }
  }
  return out
}

function extractPromptFiles(prompt: string, cwd: string): string[] {
  const candidates = prompt.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/g) ?? []
  const safe = candidates
    .map((candidate) => candidate.replace(/^['"`(]+|['"`),.]+$/g, ''))
    .filter((candidate) => candidate && !candidate.startsWith('/') && !candidate.includes('..'))
  return existingUniqueFiles(cwd, safe)
}

interface ContextBuilder {
  add(title: string, body: string, maxBytes?: number): void
  addFile(title: string, path: string, cwd: string): void
  note(note: string): void
  finish(): { content: string; notes: readonly string[]; truncated: boolean }
}

function createContextBuilder(): ContextBuilder {
  const notes: string[] = []
  let content = '# /review context\n\n'
  let bytes = Buffer.byteLength(content, 'utf8')
  let truncated = false

  function add(title: string, body: string, maxBytes = MAX_SECTION_BYTES): void {
    const capped = capText(body || '<empty>', maxBytes)
    if (capped.truncated) {
      notes.push(`${title} truncated at ${capped.bytes} bytes.`)
      truncated = true
    }

    const section = `## ${title}\n\n~~~~\n${capped.text}\n~~~~\n\n`
    const remaining = MAX_CONTEXT_BYTES - bytes
    if (remaining <= 0) {
      notes.push(`${title} omitted because review context cap was already full.`)
      truncated = true
      return
    }

    const sectionBytes = Buffer.byteLength(section, 'utf8')
    if (sectionBytes > remaining) {
      content += headBytes(section, remaining).text
      notes.push(`Total review context truncated at ${MAX_CONTEXT_BYTES} bytes.`)
      bytes = Buffer.byteLength(content, 'utf8')
      truncated = true
      return
    }

    content += section
    bytes += sectionBytes
  }

  return {
    add,
    addFile(title, path, cwd) {
      const read = readTextFile(join(cwd, path), MAX_FILE_BYTES)
      add(title, read.text, MAX_FILE_BYTES)
      if (read.note) {
        notes.push(`${path}: ${read.note}`)
        truncated = true
      }
    },
    note(note) {
      notes.push(note)
    },
    finish() {
      return { content, notes, truncated }
    }
  }
}

function readTextFile(path: string, maxBytes: number): { text: string; note?: string } {
  const stat = statSync(path)
  const limit = Math.min(maxBytes, stat.size)
  const data = Buffer.alloc(limit)
  const fd = openSync(path, 'r')
  let bytesRead = 0
  try {
    bytesRead = limit === 0 ? 0 : readSync(fd, data, 0, limit, 0)
  } finally {
    closeSync(fd)
  }
  const slice = data.subarray(0, bytesRead)
  if (isBinary(slice)) return { text: `Binary file summarized only (${stat.size} bytes).` }
  const text = slice.toString('utf8')
  if (stat.size <= bytesRead) return { text }
  return { text, note: `truncated at ${bytesRead} of ${stat.size} bytes` }
}

function capText(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const capped = headBytes(text, maxBytes, `[truncated at ${maxBytes} bytes]`)
  return {
    text: capped.text,
    bytes: capped.truncation?.limitBytes ?? Buffer.byteLength(capped.text, 'utf8'),
    truncated: Boolean(capped.truncation)
  }
}

function isBinary(data: Buffer): boolean {
  if (data.includes(0)) return true
  const sample = data.subarray(0, Math.min(data.length, 4096)).toString('utf8')
  return sample.includes('�')
}
