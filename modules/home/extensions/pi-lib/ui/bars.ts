import type { TextStyle } from './components.ts'
import { fitLine, padLine } from './render.ts'

export interface UiBarSegment {
  readonly label: string
  readonly value: number
  readonly char?: string
  readonly style?: TextStyle
}

export interface ProportionalBarOptions {
  readonly width: number
  readonly emptyChar?: string
  readonly emptyLabel?: string
}

export function renderProportionalBar(segments: readonly UiBarSegment[], options: ProportionalBarOptions): string {
  const width = Math.max(1, options.width)
  const positive = segments.filter((segment) => Number.isFinite(segment.value) && segment.value > 0)
  const total = positive.reduce((sum, segment) => sum + segment.value, 0)
  if (total <= 0) return fitLine(options.emptyLabel ?? (options.emptyChar ?? '░').repeat(width), width, '')

  const rawWidths = positive.map((segment) => (segment.value / total) * width)
  const floors = rawWidths.map(Math.floor)
  let remaining = width - floors.reduce((sum, value) => sum + value, 0)
  const order = rawWidths
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction)
  for (const entry of order) {
    if (remaining <= 0) break
    floors[entry.index] = (floors[entry.index] ?? 0) + 1
    remaining--
  }

  return positive
    .map((segment, index) => {
      const text = (segment.char ?? '█').repeat(floors[index] ?? 0)
      return segment.style ? segment.style(text) : text
    })
    .join('')
}

export interface StackedBarOptions {
  readonly width: number
  readonly labelWidth?: number
  readonly valueFormatter?: (value: number, segment: UiBarSegment) => string
  readonly emptyLabel?: string
}

export function renderStackedSectionBar(segments: readonly UiBarSegment[], options: StackedBarOptions): string[] {
  const labelWidth = Math.max(1, options.labelWidth ?? 18)
  const barWidth = Math.max(1, options.width - labelWidth - 3)
  const positive = segments.filter((segment) => Number.isFinite(segment.value) && segment.value > 0)
  const max = positive.reduce((current, segment) => Math.max(current, segment.value), 0)
  if (positive.length === 0 || max <= 0) return [fitLine(options.emptyLabel ?? 'No sections', options.width)]

  return positive.map((segment) => {
    const filled = Math.max(1, Math.round((segment.value / max) * barWidth))
    const bar = (segment.char ?? '█').repeat(filled).padEnd(barWidth, '░')
    const styledBar = segment.style ? segment.style(bar) : bar
    const label = fitLine(segment.label.padEnd(labelWidth, ' '), labelWidth, '')
    const value = options.valueFormatter?.(segment.value, segment) ?? String(segment.value)
    return fitLine(`${label} ${styledBar} ${value}`, options.width)
  })
}

export function renderBarLegend(segments: readonly UiBarSegment[], width: number): string {
  const labels = segments
    .filter((segment) => Number.isFinite(segment.value) && segment.value > 0)
    .map((segment) => `${segment.char ?? '█'} ${segment.label}`)
    .join(' • ')
  return fitLine(labels, width)
}

export { padLine as fitVisible } from './render.ts'
