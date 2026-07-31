import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { seededIndex } from './rng.ts'
import type { Companion } from './types.ts'

export const REACTION_STATES = ['impressed', 'concerned', 'amused', 'excited', 'thinking', 'happy', 'neutral'] as const
export type ReactionState = (typeof REACTION_STATES)[number]
export type ReactionSource =
  | 'prompt:name'
  | 'prompt:frustration'
  | 'prompt:excitement'
  | 'prompt:tone'
  | 'assistant:completion'
  | 'observe'
  | 'tool:error'
  | 'pet'
  | 'level-up'

export interface ReactionSpec {
  readonly source: ReactionSource
  readonly state: ReactionState
  readonly text: string
  readonly eyeOverride: string
  readonly indicator: string
  readonly ttlMs: number
  readonly bubbleLines?: readonly string[]
}

export interface StoredReaction extends Omit<ReactionSpec, 'ttlMs' | 'bubbleLines'> {
  readonly id: string
  readonly companionId: string
  readonly expiresAt: number
  readonly bubbleLines: readonly string[]
}

const REACTION_MAP: Record<ReactionState, { readonly eye: string; readonly indicator: string }> = {
  impressed: { eye: '✦', indicator: '!' },
  concerned: { eye: '×', indicator: '?' },
  amused: { eye: '°', indicator: '~' },
  excited: { eye: '◉', indicator: '!!' },
  thinking: { eye: '·', indicator: '...' },
  happy: { eye: '^', indicator: '!' },
  neutral: { eye: '', indicator: '' }
}

const REACTION_KEYWORDS: Record<Exclude<ReactionState, 'happy' | 'neutral'>, readonly string[]> = {
  impressed: ['refactor', 'clean', 'elegant', 'optimize', 'solid', 'well-structured', 'nice'],
  concerned: ['bug', 'error', 'fail', 'crash', 'null', 'undefined', 'broken', 'wrong', 'issue'],
  amused: ['hack', 'workaround', 'todo', 'fixme', 'magic number', 'copy-paste', 'yolo'],
  excited: ['ship', 'deploy', 'release', 'merge', 'complete', 'done', 'pass', 'success'],
  thinking: ['complex', 'architect', 'design', 'pattern', 'tradeoff', 'restructure', 'trade-off']
}

const FRUSTRATION_REGEX =
  /\b(?:wtf|ugh+|argh+|grr+|not working|doesn['’]?t work|still broken|why (?:is|won['’]?t|doesn['’]?t)|this is (?:so |still )?broken|i['’]?m stuck|stuck on this|can['’]?t figure|so frustrated)\b/i
const EXCITEMENT_REGEX =
  /\b(?:awesome|nailed it|love it|works?!|(?:it['’]?s? )?working!|finally!|hell yeah|let['’]?s (?:go|ship)|shipped it|we did it)(?!\w)/i
const TONE_REGEX =
  /\b(?:please|thanks|thank you|careful|carefully|gently|be honest|be direct|quickly|urgent|no rush|take your time)\b/i
const ERROR_REGEX = /\berror:|Error:|\bENOENT\b|\bEACCES\b|exit code [1-9]\d*|\bFAILED\b|panicked at/i

const NAME_REACTIONS = ['you called~?', 'hm? oh hi!', 'yeah?', 'present!', 'listening...'] as const
const FRUSTRATION_REACTIONS = [
  "hey, let's figure this out together",
  "ugh, debugging again... I'm here",
  "something's being tricky. let's get it",
  "don't worry, we'll crack it"
] as const
const EXCITEMENT_REACTIONS = [
  'yes!! great energy',
  "that's the good stuff!",
  'love when things click',
  "let's keep that momentum"
] as const
const TONE_REACTIONS = ['tone noted. matching pace.', 'got it — calibrating.', 'heard you. staying sharp.'] as const
const TOOL_ERROR_REACTIONS = [
  "hmm, that doesn't look right...",
  'uh oh, something went wrong',
  'that error might need attention',
  'something broke — want to investigate?'
] as const

export function reactionFromState(
  source: ReactionSource,
  state: ReactionState,
  text: string,
  ttlMs: number,
  bubbleLines?: readonly string[]
): ReactionSpec {
  const mapped = REACTION_MAP[state]
  return {
    source,
    state,
    text,
    ttlMs,
    bubbleLines,
    eyeOverride: mapped.eye,
    indicator: mapped.indicator
  }
}

export function inferSummaryReaction(summary: string, text: string, ttlMs = 10_000): ReactionSpec {
  const state = inferReactionState(summary)
  return reactionFromState('observe', state, text, ttlMs)
}

export function inferPromptReaction(companion: Companion, prompt: string): ReactionSpec | null {
  if (!prompt.trim()) return null

  if (new RegExp(`\\b${escapeRegex(companion.name)}\\b`, 'i').test(prompt)) {
    return reactionFromState('prompt:name', 'excited', pick(NAME_REACTIONS, companion.id, 'prompt:name'), 8_000)
  }

  if (FRUSTRATION_REGEX.test(prompt)) {
    return reactionFromState(
      'prompt:frustration',
      'concerned',
      pick(FRUSTRATION_REACTIONS, prompt, 'prompt:frustration'),
      12_000
    )
  }

  if (EXCITEMENT_REGEX.test(prompt)) {
    return reactionFromState(
      'prompt:excitement',
      'happy',
      pick(EXCITEMENT_REACTIONS, prompt, 'prompt:excitement'),
      10_000
    )
  }

  if (TONE_REGEX.test(prompt)) {
    return reactionFromState('prompt:tone', 'thinking', pick(TONE_REACTIONS, prompt, 'prompt:tone'), 10_000)
  }

  return null
}

export function inferToolReaction(toolName: string, result: unknown, isError?: boolean): ReactionSpec | null {
  const output = toolResultText(result)
  if (!isError && !ERROR_REGEX.test(output)) return null
  const seed = `${toolName}:${output.slice(0, 120)}`
  return reactionFromState('tool:error', 'concerned', pick(TOOL_ERROR_REACTIONS, seed, 'tool:error'), 12_000)
}

export function storeReaction(
  db: Database,
  companion: Companion,
  reaction: ReactionSpec,
  now = Date.now()
): StoredReaction {
  pruneExpiredReactions(db, now)
  const active = getActiveReaction(db, companion.id, now)
  if (active && reactionPriority(active.source) > reactionPriority(reaction.source)) return active
  if (active) db.query('DELETE FROM reactions WHERE id = ?').run(active.id)

  const id = randomUUID()
  const expiresAt = now + reaction.ttlMs
  const bubbleLines = reaction.bubbleLines ?? []
  db.query(`
    INSERT INTO reactions (id, companion_id, source, state, text, eye_override, indicator, bubble_lines, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    companion.id,
    reaction.source,
    reaction.state,
    reaction.text,
    reaction.eyeOverride,
    reaction.indicator,
    JSON.stringify(bubbleLines),
    expiresAt
  )

  return {
    id,
    companionId: companion.id,
    source: reaction.source,
    state: reaction.state,
    text: reaction.text,
    eyeOverride: reaction.eyeOverride,
    indicator: reaction.indicator,
    expiresAt,
    bubbleLines
  }
}

export function getActiveReaction(db: Database, companionId: string, now = Date.now()): StoredReaction | null {
  const row = db
    .query('SELECT * FROM reactions WHERE companion_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
    .get(companionId, now) as ReactionRow | null
  return row ? rowToStoredReaction(row) : null
}

export function pruneExpiredReactions(db: Database, now = Date.now()): number {
  return db.query('DELETE FROM reactions WHERE expires_at <= ?').run(now).changes
}

function reactionPriority(source: ReactionSource): number {
  switch (source) {
    case 'level-up':
      return 100
    case 'tool:error':
      return 80
    case 'pet':
      return 60
    case 'observe':
      return 50
    case 'assistant:completion':
      return 45
    case 'prompt:frustration':
      return 40
    case 'prompt:name':
      return 30
    case 'prompt:excitement':
    case 'prompt:tone':
      return 20
    default:
      return 0
  }
}

function inferReactionState(summary: string): ReactionState {
  const lower = summary.toLowerCase()
  for (const state of ['impressed', 'concerned', 'amused', 'excited', 'thinking'] as const) {
    if (REACTION_KEYWORDS[state].some((keyword) => lower.includes(keyword.toLowerCase()))) return state
  }
  return 'neutral'
}

function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return String(result ?? '')
  const value = result as {
    content?: unknown
    text?: unknown
    stdout?: unknown
    stderr?: unknown
  }
  const content = Array.isArray(value.content)
    ? value.content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n')
    : ''
  return [value.text, value.stdout, value.stderr, content]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
}

function rowToStoredReaction(row: ReactionRow): StoredReaction {
  return {
    id: row.id,
    companionId: row.companion_id,
    source: row.source as ReactionSource,
    state: row.state as ReactionState,
    text: row.text,
    eyeOverride: row.eye_override ?? '',
    indicator: row.indicator ?? '',
    expiresAt: row.expires_at,
    bubbleLines: parseBubbleLines(row.bubble_lines)
  }
}

function parseBubbleLines(raw: string | null): readonly string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function pick(values: readonly string[], seed: string, namespace: string): string {
  return values[seededIndex(seed, namespace, values.length)]!
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ReactionRow {
  readonly id: string
  readonly companion_id: string
  readonly source: string
  readonly state: string
  readonly text: string
  readonly eye_override: string | null
  readonly indicator: string | null
  readonly bubble_lines: string | null
  readonly expires_at: number
}
