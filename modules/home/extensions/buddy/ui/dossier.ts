import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import { fitLine, padLine, renderProportionalBar } from '@pi/lib/ui'
import { levelProgress } from '../core/leveling.ts'
import { getDumpStat, getPeakStat, RARITY_STARS, STAT_NAMES, type Companion, type StatName } from '../core/types.ts'
import { renderBuddyPresenceSprite } from './render.ts'

const MIN_WIDTH = 44
const BAR_WIDTH = 10
const DIVIDER = '─'
const COLUMN_GAP = '  '

type StatEmphasis = 'peak' | 'dump' | 'normal'

type DossierTheme = Pick<Theme, 'fg'>

export function renderBuddyDossier(companion: Companion, width = 56, theme?: DossierTheme): readonly string[] {
  const safeWidth = Math.max(MIN_WIDTH, width)
  const peak = getPeakStat(companion.stats)
  const dump = getDumpStat(companion.stats)
  const stats = STAT_NAMES.map((stat) =>
    renderStatLine(stat, companion.stats[stat], statEmphasis(stat, peak, dump), theme)
  )
  const level = levelProgress(companion.xp)
  const xpLine =
    level.level >= 50
      ? 'lvl 50 MAX'
      : `lvl ${level.level} ${bar(level.progress, BAR_WIDTH)} ${level.currentXp}/${level.neededXp}`
  const statsWidth = Math.max(1, ...stats.map((line) => visibleWidth(line)))
  const leftWidth = Math.max(1, safeWidth - statsWidth - visibleWidth(COLUMN_GAP))
  const sprite = renderBuddyPresenceSprite(companion, {
    includeName: false,
    shiftDown: false,
    maxWidth: leftWidth
  })
  const description = wrapText(companion.personalityBio.trim(), safeWidth)

  return [
    joinEdges(companion.name, companion.mood, safeWidth),
    joinEdges(`${companion.species} ${RARITY_STARS[companion.rarity]}`, xpLine, safeWidth),
    divider(safeWidth),
    ...joinColumns(sprite, stats, leftWidth, statsWidth, safeWidth),
    divider(safeWidth),
    ...description
  ]
}

function joinColumns(
  leftLines: readonly string[],
  rightLines: readonly string[],
  leftWidth: number,
  rightWidth: number,
  width: number
): string[] {
  const rows = Math.max(leftLines.length, rightLines.length)
  const lines: string[] = []

  for (let index = 0; index < rows; index++) {
    const left = centerPlain(leftLines[index] ?? '', leftWidth)
    const right = padLine(fit(rightLines[index] ?? '', rightWidth), rightWidth)
    lines.push(fit(`${left}${COLUMN_GAP}${right}`, width))
  }

  return lines
}

function renderStatLine(
  stat: StatName,
  value: number,
  emphasis: StatEmphasis,
  theme: DossierTheme | undefined
): string {
  const clamped = Math.max(0, Math.min(100, value))
  const line = `${stat.padEnd(9)}  ${bar(clamped / 100, BAR_WIDTH)} ${String(clamped).padStart(3)}`
  if (!theme) return line
  if (emphasis === 'peak') return theme.fg('success', line)
  if (emphasis === 'dump') return theme.fg('warning', line)
  return theme.fg('muted', line)
}

function statEmphasis(stat: StatName, peak: StatName, dump: StatName): StatEmphasis {
  if (stat === peak) return 'peak'
  if (stat === dump) return 'dump'
  return 'normal'
}

function bar(progress: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, progress))
  return renderProportionalBar(
    [
      { label: 'filled', value: clamped, char: '█' },
      { label: 'empty', value: 1 - clamped, char: '░' }
    ],
    { width }
  )
}

function divider(width: number): string {
  return DIVIDER.repeat(Math.max(0, width))
}

function joinEdges(left: string, right: string, width: number): string {
  const cleanRight = fit(right, width)
  const rightWidth = visibleWidth(cleanRight)
  const leftBudget = Math.max(0, width - rightWidth - 1)
  const cleanLeft = fit(left, leftBudget)
  const gap = ' '.repeat(Math.max(1, width - visibleWidth(cleanLeft) - rightWidth))
  return `${cleanLeft}${gap}${cleanRight}`
}

function centerPlain(line: string, width: number): string {
  const fitted = fit(line, width)
  const left = Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2))
  return padLine(`${' '.repeat(left)}${fitted}`, width)
}

function fit(line: string, width: number): string {
  return width <= 0 ? '' : fitLine(line, width)
}

export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (visibleWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    if (visibleWidth(word) <= width) {
      current = word
      continue
    }
    const chunks = chunkLongWord(word, width)
    lines.push(...chunks.slice(0, -1))
    current = chunks.at(-1) ?? ''
  }

  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

function chunkLongWord(word: string, width: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const char of word) {
    if (visibleWidth(`${current}${char}`) <= width) {
      current += char
      continue
    }
    if (current) chunks.push(current)
    current = char
  }
  if (current) chunks.push(current)
  return chunks
}
