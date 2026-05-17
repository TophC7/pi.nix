// ## PARSER ## //
import { createHash } from 'node:crypto'

// Tolerant markdown parser for sdd specs. Frontmatter + H1 title + H2 sections
// + H3 tasks under "## Tasks", each task carrying a meta line and an optional
// **Acceptance:** line. Unknown sections preserved verbatim so serialize round-
// trips don't clobber free-form authoring.

export type SpecStatus = 'draft' | 'verified' | 'shipped'

export interface SpecFrontmatter {
  title: string
  status: SpecStatus
  epicId?: string
  verifiedAt?: string
}

export interface SpecAcceptance {
  kind: 'runnable' | 'manual'
  value: string
}

export interface SpecTask {
  slug: string
  title: string
  description: string
  acceptance?: SpecAcceptance
  issueId?: string
  deps: string[]
}

export interface SpecSection {
  heading: string
  body: string
}

export interface Spec {
  frontmatter: SpecFrontmatter
  goal: string
  tasks: SpecTask[]
  extras: SpecSection[]
  hash: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const META_LINE_RE = /<!--\s*sworm:\s*([^>]*?)\s*-->/
const ACCEPTANCE_LINE_RE = /^\*\*Acceptance:\*\*\s*(.+?)\s*$/

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecParseError'
  }
}

export function parseSpec(content: string): Spec {
  const fm = parseFrontmatter(content)
  const body = content.slice(fm.consumed)
  const { goal, tasks, extras } = parseBody(body)
  return {
    frontmatter: fm.frontmatter,
    goal,
    tasks,
    extras,
    hash: hashContent(content)
  }
}

interface FrontmatterParse {
  frontmatter: SpecFrontmatter
  consumed: number
}

function parseFrontmatter(content: string): FrontmatterParse {
  const match = content.match(FRONTMATTER_RE)
  if (!match) throw new SpecParseError('Spec missing required frontmatter block.')
  const raw = parseYamlish(match[1] ?? '')
  const title = raw.title?.trim()
  const status = (raw.status?.trim() ?? 'draft') as SpecStatus
  if (!title) throw new SpecParseError('Spec frontmatter missing title.')
  if (!isStatus(status)) throw new SpecParseError(`Spec frontmatter status must be draft | verified | shipped (got ${status}).`)
  return {
    frontmatter: {
      title,
      status,
      epicId: raw.epic_id?.trim() || undefined,
      verifiedAt: raw.verified_at?.trim() || undefined
    },
    consumed: match[0].length
  }
}

function isStatus(value: string): value is SpecStatus {
  return value === 'draft' || value === 'verified' || value === 'shipped'
}

function parseYamlish(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (key) out[key] = stripQuotes(value)
  }
  return out
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

interface BodyParse {
  goal: string
  tasks: SpecTask[]
  extras: SpecSection[]
}

function parseBody(body: string): BodyParse {
  // Strip the leading H1 title; serialization regenerates it from frontmatter.
  const sections = splitH2Sections(body)
  let goal = ''
  let tasks: SpecTask[] = []
  const extras: SpecSection[] = []
  for (const section of sections) {
    const name = section.heading.toLowerCase()
    if (name === 'goal') {
      goal = section.body.trim()
    } else if (name === 'tasks') {
      tasks = parseTasksSection(section.body)
    } else {
      extras.push(section)
    }
  }
  return { goal, tasks, extras }
}

function splitH2Sections(body: string): SpecSection[] {
  const lines = body.split(/\r?\n/)
  const sections: SpecSection[] = []
  let i = 0
  // skip preamble and H1 line so authors can keep a title without it counting
  // as a section
  while (i < lines.length && !lines[i]!.startsWith('## ')) i++
  while (i < lines.length) {
    const heading = lines[i]!.slice(3).trim()
    i++
    const start = i
    while (i < lines.length && !lines[i]!.startsWith('## ')) i++
    const bodyLines = lines.slice(start, i)
    sections.push({ heading, body: bodyLines.join('\n').trim() })
  }
  return sections
}

function parseTasksSection(raw: string): SpecTask[] {
  const lines = raw.split(/\r?\n/)
  const tasks: SpecTask[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i]!.startsWith('### ')) {
      i++
      continue
    }
    const title = lines[i]!.slice(4).trim()
    i++
    const start = i
    while (i < lines.length && !lines[i]!.startsWith('### ')) i++
    const block = lines.slice(start, i).join('\n')
    tasks.push(buildTask(title, block))
  }
  return tasks
}

function buildTask(title: string, block: string): SpecTask {
  const lines = block.split('\n')
  const metaIndex = lines.findIndex((line) => META_LINE_RE.test(line))
  if (metaIndex < 0) {
    throw new SpecParseError(`Task "${title}" missing required <!-- sworm: slug=... --> meta line.`)
  }
  const meta = parseMetaLine(lines[metaIndex] ?? '')
  if (!meta.slug) throw new SpecParseError(`Task "${title}" meta line missing slug.`)
  const remaining = lines.slice(0, metaIndex).concat(lines.slice(metaIndex + 1)).join('\n').trim()
  const acceptance = extractAcceptance(remaining)
  return {
    slug: meta.slug,
    title,
    description: acceptance ? acceptance.rest : remaining,
    acceptance: acceptance?.value,
    issueId: meta.id,
    deps: meta.deps
  }
}

interface MetaParse {
  slug?: string
  id?: string
  deps: string[]
}

function parseMetaLine(line: string): MetaParse {
  const match = line.match(META_LINE_RE)
  if (!match) return { deps: [] }
  const out: MetaParse = { deps: [] }
  // pairs are separated by ; so values (like deps) can use , internally
  const pairs = (match[1] ?? '').split(';')
  for (const pair of pairs) {
    const [keyPart, ...rest] = pair.split('=')
    const key = keyPart?.trim()
    const value = rest.join('=').trim()
    if (!key) continue
    if (key === 'slug') out.slug = value
    else if (key === 'id') out.id = value
    else if (key === 'deps') out.deps = value.split(',').map((d) => d.trim()).filter(Boolean)
  }
  return out
}

interface AcceptanceExtract {
  value: SpecAcceptance
  rest: string
}

function extractAcceptance(body: string): AcceptanceExtract | undefined {
  const lines = body.split('\n')
  const index = lines.findIndex((line) => ACCEPTANCE_LINE_RE.test(line.trim()))
  if (index < 0) return undefined
  const match = lines[index]!.trim().match(ACCEPTANCE_LINE_RE)
  const raw = match?.[1]?.trim() ?? ''
  const rest = lines.slice(0, index).concat(lines.slice(index + 1)).join('\n').trim()
  return { value: classifyAcceptance(raw), rest }
}

function classifyAcceptance(raw: string): SpecAcceptance {
  // Backtick-wrapped value treated as runnable shell command. Anything else
  // stays as manual prose.
  const runnable = raw.match(/^`([^`]+)`\s*\.?\s*$/)
  if (runnable && runnable[1]) return { kind: 'runnable', value: runnable[1].trim() }
  return { kind: 'manual', value: raw }
}

export function serializeSpec(spec: Spec): string {
  const frontmatter = renderFrontmatter(spec.frontmatter)
  const titleHeading = `# ${spec.frontmatter.title}`
  const goalBlock = spec.goal.trim() ? `## Goal\n\n${spec.goal.trim()}` : '## Goal\n'
  const tasksBlock = renderTasks(spec.tasks)
  const extrasBlock = spec.extras
    .map((section) => `## ${section.heading}\n\n${section.body.trim()}`)
    .join('\n\n')
  return [
    frontmatter,
    titleHeading,
    goalBlock,
    tasksBlock,
    extrasBlock
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
}

function renderFrontmatter(fm: SpecFrontmatter): string {
  const lines: string[] = ['---']
  lines.push(`title: ${fm.title}`)
  lines.push(`status: ${fm.status}`)
  lines.push(`epic_id:${fm.epicId ? ` ${fm.epicId}` : ''}`)
  if (fm.verifiedAt) lines.push(`verified_at: ${fm.verifiedAt}`)
  lines.push('---')
  return lines.join('\n')
}

function renderTasks(tasks: SpecTask[]): string {
  if (tasks.length === 0) return '## Tasks\n'
  const blocks = tasks.map(renderTask)
  return `## Tasks\n\n${blocks.join('\n\n')}`
}

function renderTask(task: SpecTask): string {
  const meta = renderMetaLine(task)
  const acceptance = task.acceptance ? renderAcceptance(task.acceptance) : ''
  const desc = task.description.trim()
  const parts = [`### ${task.title}`, meta]
  if (acceptance) parts.push(acceptance)
  if (desc) parts.push(desc)
  return parts.join('\n\n')
}

function renderMetaLine(task: SpecTask): string {
  const pairs: string[] = [`slug=${task.slug}`]
  if (task.issueId) pairs.push(`id=${task.issueId}`)
  if (task.deps.length > 0) pairs.push(`deps=${task.deps.join(',')}`)
  return `<!-- sworm: ${pairs.join('; ')} -->`
}

function renderAcceptance(acceptance: SpecAcceptance): string {
  if (acceptance.kind === 'runnable') return `**Acceptance:** \`${acceptance.value}\``
  return `**Acceptance:** ${acceptance.value}`
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function emptySpec(title: string): Spec {
  return {
    frontmatter: { title, status: 'draft' },
    goal: '',
    tasks: [],
    extras: [],
    hash: ''
  }
}
