import { visibleWidth } from '@mariozechner/pi-tui'
import { fitLine, padLine } from '@pi/lib/ui'
import type { StoredReaction } from '../core/reactions.ts'
import { renderFace, renderSprite } from '../core/species.ts'
import type { Companion, Eye } from '../core/types.ts'

export interface BuddyRenderContext {
  readonly width: number
  readonly tick?: number
}

export interface BuddyPresenceSpriteOptions {
  readonly eye?: Eye
  readonly frame?: number
  readonly maxWidth?: number
  readonly includeName?: boolean
  readonly shiftDown?: boolean
}

export interface BuddyInputSpriteOptions {
  readonly eye?: Eye
  readonly frame?: number
  readonly maxWidth?: number
}

const FOOTER_BUDDY_MAX_TERMINAL_WIDTH = 62

let cachedCompanion: Companion | null = null
let cachedReaction: StoredReaction | null = null

export function refreshBuddyRenderState(companion: Companion | null, reaction: StoredReaction | null): void {
  cachedCompanion = companion
  cachedReaction = reaction
}

export function renderBuddyInput(context: BuddyRenderContext): readonly string[] {
  if (!cachedCompanion) return []

  const reaction = activeReaction(cachedCompanion)
  const eye = (reaction?.eyeOverride as Eye | undefined) ?? cachedCompanion.eye
  return renderBuddyInputSprite(cachedCompanion, {
    eye,
    frame: context.tick ?? 0,
    maxWidth: context.width
  })
}

export function renderBuddyFooter(context: BuddyRenderContext): readonly string[] {
  if (!cachedCompanion) return []

  const reaction = activeReaction(cachedCompanion)
  const eye = (reaction?.eyeOverride as Eye | undefined) ?? cachedCompanion.eye
  const compactFace = context.width < FOOTER_BUDDY_MAX_TERMINAL_WIDTH ? ` ${renderFace({ ...cachedCompanion, eye })}` : ''
  return [fitPlain(`${cachedCompanion.name}${compactFace}`, context.width)]
}

export function renderBuddyInputSprite(
  companion: Companion,
  options: BuddyInputSpriteOptions = {}
): readonly string[] {
  const sprite = rawSpriteLines(companion, options)
  if (sprite.length === 0) return []
  return normalizeLines(sprite, options.maxWidth)
}

export function renderBuddyPresenceSprite(
  companion: Companion,
  options: BuddyPresenceSpriteOptions = {}
): readonly string[] {
  const sprite = rawSpriteLines(companion, options)
  if (sprite.length === 0) return []

  const includeName = options.includeName ?? false
  const normalized = normalizeLines(sprite, options.maxWidth, includeName ? companion.name : undefined)
  const namedSprite = includeName ? insertNameBeforeFeet(normalized, companion.name, visibleWidth(normalized[0] ?? '')) : normalized
  return options.shiftDown ? ['', ...namedSprite] : namedSprite
}

function rawSpriteLines(companion: Companion, options: BuddyPresenceSpriteOptions | BuddyInputSpriteOptions): string[] {
  return cropSpriteCanvas(
    renderSprite({ ...companion, eye: options.eye ?? companion.eye }, options.frame ?? 0)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
  )
}

function cropSpriteCanvas(lines: readonly string[]): string[] {
  const bounds = lines
    .map((line) => ({ start: firstInkIndex(line), end: lastInkIndex(line) }))
    .filter((bound) => bound.start >= 0 && bound.end >= bound.start)
  if (bounds.length === 0) return []

  const left = Math.min(...bounds.map((bound) => bound.start))
  const right = Math.max(...bounds.map((bound) => bound.end))
  const width = Math.max(1, right - left + 1)
  return lines.map((line) => padLine(line.slice(left, right + 1).trimEnd(), width))
}

function firstInkIndex(line: string): number {
  for (let index = 0; index < line.length; index++) if (line[index] !== ' ') return index
  return -1
}

function lastInkIndex(line: string): number {
  for (let index = line.length - 1; index >= 0; index--) if (line[index] !== ' ') return index
  return -1
}

function normalizeLines(lines: readonly string[], maxWidth?: number, extra?: string): string[] {
  const naturalWidth = Math.max(...lines.map((line) => visibleWidth(line)), extra ? visibleWidth(extra) : 0, 1)
  const width = Math.max(1, Math.min(maxWidth ?? naturalWidth, naturalWidth))
  return lines.map((line) => padLine(fitPlain(line, width), width))
}

function insertNameBeforeFeet(sprite: readonly string[], name: string, width: number): readonly string[] {
  const feet = sprite.at(-1)
  if (!feet) return [centerPlain(name, width)]
  return [...sprite.slice(0, -1), centerPlain(name, width), feet]
}

function fitPlain(line: string, width: number): string {
  return fitLine(line, width)
}

function centerPlain(line: string, width: number): string {
  const fitted = fitPlain(line, width)
  const left = Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2))
  return padLine(`${' '.repeat(left)}${fitted}`, width)
}

function activeReaction(companion: Companion): StoredReaction | null {
  if (!cachedReaction || cachedReaction.companionId !== companion.id) return null
  return cachedReaction.expiresAt > Date.now() ? cachedReaction : null
}
