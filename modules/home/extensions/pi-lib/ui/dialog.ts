import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent'
import { type Component, type Input, type TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { type OverlayHandle, type OverlayOptions, openOverlay } from './overlay.ts'
import { padLine } from './render.ts'

// ABOUT: Plain framed dialog primitive matching pi-tool-display. The frame
// is purely structural: a square border around the content with no title,
// search, or help baked into it. Content components compose their own
// chrome via shared helpers (renderDialogHeader / renderDialogDivider /
// renderDialogFooter) so every dialog renders header / body / footer
// rows the same way.

export interface DialogOptions extends OverlayOptions {
  readonly padding?: number
  readonly minWidth?: number
  readonly maxWidth?: number
  readonly borderStyle?: 'rounded' | 'square'
  readonly focused?: boolean
}

export interface DialogFactoryArgs {
  readonly tui: TUI
  readonly theme: Theme
  readonly close: () => void
}

export type DialogContent = Component

interface BorderChars {
  readonly topLeft: string
  readonly topRight: string
  readonly bottomLeft: string
  readonly bottomRight: string
  readonly horizontal: string
  readonly vertical: string
}

const BORDER_STYLES: Record<NonNullable<DialogOptions['borderStyle']>, BorderChars> = {
  rounded: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│'
  },
  square: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│'
  }
}

const NERD_FONT_TERMINAL_HINTS = [
  'iterm',
  'wezterm',
  'kitty',
  'ghostty',
  'alacritty',
  'xfce4-terminal',
  'gnome-terminal',
  'tilix',
  'terminator',
  'konsole'
] as const

export interface DialogIconSet {
  readonly search: string
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === '1' || value?.toLowerCase() === 'true') return true
  if (value === '0' || value?.toLowerCase() === 'false') return false
  return undefined
}

function detectNerdFonts(): boolean {
  const explicit = parseBooleanEnv(process.env.PI_NERD_FONTS) ?? parseBooleanEnv(process.env.POWERLINE_NERD_FONTS)
  if (explicit !== undefined) return explicit
  if (process.env.GHOSTTY_RESOURCES_DIR) return true
  const fingerprint = `${(process.env.TERM_PROGRAM ?? '').toLowerCase()} ${(process.env.TERM ?? '').toLowerCase()}`
  return NERD_FONT_TERMINAL_HINTS.some((term) => fingerprint.includes(term))
}

export function getDialogIcons(): DialogIconSet {
  return detectNerdFonts() ? { search: '\uF002' } : { search: '🔍' }
}

export function openDialog(
  ctx: ExtensionCommandContext,
  factory: (args: DialogFactoryArgs) => DialogContent,
  options: DialogOptions = {}
): OverlayHandle {
  return openOverlay(ctx, ({ tui, theme, close }) => new DialogFrame(factory({ tui, theme, close }), theme, options), {
    width: options.width,
    maxHeight: options.maxHeight
  })
}

export class DialogFrame implements Component {
  private readonly borders: BorderChars

  constructor(
    private readonly content: DialogContent,
    private readonly theme: Theme,
    private readonly options: DialogOptions = {}
  ) {
    this.borders = BORDER_STYLES[options.borderStyle ?? 'square']
  }

  render(width: number): string[] {
    const frameWidth = this.resolveFrameWidth(Math.max(4, width))
    const padding = Math.max(0, this.options.padding ?? 0)
    const innerWidth = Math.max(1, frameWidth - 2)
    const contentWidth = Math.max(1, innerWidth - padding * 2)
    const sidePad = ' '.repeat(padding)

    const rows: string[] = [this.renderTopBorder(frameWidth)]
    const contentLines = safeRender(this.content, contentWidth)

    for (let i = 0; i < padding; i += 1) rows.push(this.renderBodyLine(''.padEnd(innerWidth), innerWidth))
    for (const line of contentLines) {
      const body = `${sidePad}${padLine(truncateToWidth(line, contentWidth, '', true), contentWidth)}${sidePad}`
      rows.push(this.renderBodyLine(body, innerWidth))
    }
    for (let i = 0; i < padding; i += 1) rows.push(this.renderBodyLine(''.padEnd(innerWidth), innerWidth))

    rows.push(this.renderBottomBorder(frameWidth))
    return rows
  }

  invalidate(): void {
    this.content.invalidate()
  }

  handleInput(data: string): void {
    this.content.handleInput?.(data)
  }

  private resolveFrameWidth(availableWidth: number): number {
    const maxWidth = this.options.maxWidth && this.options.maxWidth > 0 ? this.options.maxWidth : availableWidth
    const minWidth = Math.max(4, this.options.minWidth ?? 40)
    const bounded = Math.min(availableWidth, maxWidth)
    return Math.min(availableWidth, Math.max(minWidth, bounded))
  }

  private renderTopBorder(width: number): string {
    const innerWidth = Math.max(0, width - 2)
    return `${this.border(this.borders.topLeft)}${this.border(this.borders.horizontal.repeat(innerWidth))}${this.border(this.borders.topRight)}`
  }

  private renderBottomBorder(width: number): string {
    const innerWidth = Math.max(0, width - 2)
    return `${this.border(this.borders.bottomLeft)}${this.border(this.borders.horizontal.repeat(innerWidth))}${this.border(this.borders.bottomRight)}`
  }

  private renderBodyLine(content: string, innerWidth: number): string {
    return `${this.border(this.borders.vertical)}${padLine(content, innerWidth)}${this.border(this.borders.vertical)}`
  }

  private border(text: string): string {
    const slot = (this.options.focused ?? true) ? 'accent' : 'dim'
    return this.theme.fg(slot, text)
  }
}

function safeRender(content: DialogContent, width: number): string[] {
  const lines = content.render(width)
  return lines.length > 0 ? lines : ['']
}

// Shared chrome helpers — every dialog body renders the same header/divider/footer
// pattern so the visual is consistent across settings, burden, markdown overlay.

export interface DialogHeaderOptions {
  readonly title: string
  readonly theme: Theme
  readonly width: number
  readonly searchInput?: Input
  readonly searchBoxWidth?: number
}

const SEARCH_BOX_MIN_WIDTH = 12
const SEARCH_BOX_MAX_WIDTH = 28

export function renderDialogHeader(options: DialogHeaderOptions): string {
  const safeWidth = Math.max(1, options.width)
  const titleText = options.theme.fg('accent', options.theme.bold(options.title))
  const titleWidth = visibleWidth(titleText)
  if (!options.searchInput) return padToWidth(titleText, safeWidth)
  const searchBox = renderDialogSearchBox(
    options.searchInput,
    options.theme,
    options.searchBoxWidth ?? clampInt(Math.floor(safeWidth * 0.18), SEARCH_BOX_MIN_WIDTH, SEARCH_BOX_MAX_WIDTH)
  )
  const searchWidth = visibleWidth(searchBox)
  const gap = Math.max(1, safeWidth - titleWidth - searchWidth)
  if (titleWidth + searchWidth + 1 > safeWidth) {
    return truncateToWidth(`${titleText} ${searchBox}`, safeWidth, '', true)
  }
  return `${titleText}${' '.repeat(gap)}${searchBox}`
}

export function renderDialogSearchBox(input: Input, theme: Theme, innerWidth: number): string {
  const desired = Math.max(SEARCH_BOX_MIN_WIDTH, Math.min(SEARCH_BOX_MAX_WIDTH, innerWidth))
  const rendered = input.render(desired + 2)[0] ?? '> '
  const stripped = rendered.startsWith('> ') ? rendered.slice(2) : rendered
  const inner = padToWidth(stripped, desired)
  return `${theme.fg('muted', getDialogIcons().search)} ${theme.fg('dim', '[')}${inner}${theme.fg('dim', ']')}`
}

export interface DialogDividerOptions {
  readonly theme: Theme
  readonly width: number
  readonly splitAt?: number
}

export function renderDialogDivider(options: DialogDividerOptions): string {
  const safeWidth = Math.max(1, options.width)
  const paint = (text: string) => options.theme.fg('dim', text)
  if (options.splitAt === undefined || options.splitAt <= 0 || options.splitAt >= safeWidth) {
    return paint('─'.repeat(safeWidth))
  }
  return `${paint('─'.repeat(options.splitAt))}${paint('┬')}${paint('─'.repeat(Math.max(1, safeWidth - options.splitAt - 1)))}`
}

export interface DialogFooterKey {
  readonly key: string
  readonly label: string
}

export interface DialogFooterOptions {
  readonly theme: Theme
  readonly width: number
  readonly keys: readonly DialogFooterKey[]
  readonly status?: string
}

export function renderDialogFooter(options: DialogFooterOptions): string {
  const safeWidth = Math.max(1, options.width)
  const separator = options.theme.fg('dim', ' │ ')
  const formatted = options.keys.map(
    ({ key, label }) => `${options.theme.fg('muted', options.theme.bold(key))} ${options.theme.fg('dim', label)}`
  )
  let line = formatted.join(separator)
  if (options.status) {
    const statusText = options.theme.fg('muted', options.status)
    const lineWidth = visibleWidth(line)
    const statusWidth = visibleWidth(statusText)
    const gap = Math.max(1, safeWidth - lineWidth - statusWidth)
    if (lineWidth + statusWidth + 1 <= safeWidth) {
      line = `${line}${' '.repeat(gap)}${statusText}`
    }
  }
  return truncateToWidth(padToWidth(line, safeWidth), safeWidth, '…', true)
}

function padToWidth(text: string, width: number): string {
  const w = visibleWidth(text)
  if (w >= width) return truncateToWidth(text, width, '…', true)
  return `${text}${' '.repeat(width - w)}`
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
