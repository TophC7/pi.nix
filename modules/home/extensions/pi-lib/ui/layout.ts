import { visibleWidth } from '@mariozechner/pi-tui'
import type { TextStyle } from './components.ts'
import { fitLine, padLine } from './render.ts'

export type OverlayDimension = number | `${number}%`

export interface CenteredOverlaySizing {
  readonly width?: OverlayDimension
  readonly maxHeight?: OverlayDimension
}

export function centeredOverlayOptions(options: CenteredOverlaySizing = {}) {
  return {
    overlay: true,
    overlayOptions: {
      anchor: 'center' as const,
      width: options.width ?? '80%',
      maxHeight: options.maxHeight ?? '80%'
    }
  }
}

export interface KeybindingFooterItem {
  readonly key: string
  readonly label: string
  readonly disabled?: boolean
}

export interface KeybindingFooterOptions {
  readonly separator?: string
  readonly accent?: TextStyle
  readonly dim?: TextStyle
}

export function renderKeybindingFooter(
  items: readonly KeybindingFooterItem[],
  options: KeybindingFooterOptions = {}
): string {
  const separator = options.separator ?? ' • '
  return items
    .filter((item) => !item.disabled)
    .map((item) => `${style(item.key, options.accent)} ${style(item.label, options.dim)}`)
    .join(separator)
}

export interface CenteredFrameOptions {
  readonly title?: string
  readonly body: readonly string[]
  readonly status?: string | readonly string[]
  readonly footer?: string | readonly string[]
  readonly minWidth?: number
  readonly maxWidth?: number
  readonly accent?: TextStyle
  readonly dim?: TextStyle
}

export function renderCenteredFrame(viewportWidth: number, options: CenteredFrameOptions): string[] {
  const safeViewportWidth = Math.max(1, viewportWidth)
  const frameWidth = chooseFrameWidth(safeViewportWidth, options)
  if (frameWidth < 4) return options.body.map((line) => fitLine(line, safeViewportWidth))

  const innerWidth = frameWidth - 2
  const rows: string[] = []
  const separator = `├${'─'.repeat(innerWidth)}┤`

  rows.push(`╭${'─'.repeat(innerWidth)}╮`)
  if (options.title) {
    rows.push(frameLine(style(options.title, options.accent), innerWidth))
    rows.push(separator)
  }
  for (const line of options.body) rows.push(frameLine(line, innerWidth))

  const statusLines = sectionLines(options.status)
  if (statusLines.length > 0) {
    rows.push(separator)
    for (const line of statusLines) rows.push(frameLine(style(line, options.dim), innerWidth))
  }

  const footerLines = sectionLines(options.footer)
  if (footerLines.length > 0) {
    rows.push(separator)
    for (const line of footerLines) rows.push(frameLine(style(line, options.dim), innerWidth))
  }
  rows.push(`╰${'─'.repeat(innerWidth)}╯`)

  return centerLines(rows, safeViewportWidth)
}

export function renderStatusLine(text: string | undefined, width: number, dim?: TextStyle): string {
  return padLine(style(text ?? '', dim), width)
}

export function renderFooterLine(text: string | undefined, width: number, dim?: TextStyle): string {
  return padLine(style(text ?? '', dim), width)
}

function chooseFrameWidth(viewportWidth: number, options: CenteredFrameOptions): number {
  const minWidth = Math.max(1, options.minWidth ?? Math.min(48, viewportWidth))
  const maxWidth = Math.max(minWidth, options.maxWidth ?? viewportWidth)
  return Math.max(1, Math.min(viewportWidth, maxWidth))
}

function sectionLines(section: string | readonly string[] | undefined): string[] {
  if (section === undefined) return []
  return typeof section === 'string' ? [section] : [...section]
}

function frameLine(text: string, width: number): string {
  return `│${padLine(text, width)}│`
}

function centerLines(lines: readonly string[], viewportWidth: number): string[] {
  return lines.map((line) => {
    const indent = Math.max(0, Math.floor((viewportWidth - visibleWidth(line)) / 2))
    return `${' '.repeat(indent)}${line}`
  })
}

function style(text: string, styleFn: TextStyle | undefined): string {
  return styleFn ? styleFn(text) : text
}
