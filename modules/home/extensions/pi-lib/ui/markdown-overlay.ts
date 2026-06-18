// ABOUT: Scrollable markdown overlay built on the shared overlay helper.
// Pre-renders markdown through pi-tui, owns scroll state, and pads content so
// callers get predictable clipping plus "more above/below" indicators.

import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Key, Markdown, type MarkdownTheme, matchesKey } from '@earendil-works/pi-tui'
import {
  type DialogContent,
  openDialog,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader
} from './dialog.ts'
import type { OverlayHandle } from './overlay.ts'
import { padLine } from './render.ts'

const DEFAULT_PADDING_X = 1
const DEFAULT_VISIBLE_ROWS = 28

export interface MarkdownOverlayOptions {
  readonly title: string
  readonly markdown: string
  readonly width?: number | `${number}%`
  readonly maxHeight?: number | `${number}%`
  /** Visible body rows; default 18. Caller can size to terminal height. */
  readonly visibleRows?: number
  /** Horizontal padding inside the overlay; default 2 columns each side. */
  readonly paddingX?: number
}

export class MarkdownOverlayBody implements DialogContent {
  private offset = 0
  private renderedLines: string[] | undefined
  private renderedWidth: number | undefined
  private readonly markdownTheme: MarkdownTheme
  private readonly visibleRows: number
  private readonly paddingX: number

  constructor(
    private readonly theme: Theme,
    private readonly markdown: string,
    private readonly closeOverlay: () => void,
    visibleRows: number,
    paddingX: number
  ) {
    this.markdownTheme = resolveMarkdownTheme()
    this.visibleRows = Math.max(3, visibleRows)
    this.paddingX = Math.max(0, paddingX)
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.closeOverlay()
      return
    }
    const lines = this.renderedLines
    if (!lines) return
    const maxOffset = Math.max(0, lines.length - this.visibleRows)

    if (matchesKey(data, Key.up)) this.setOffset(this.offset - 1, maxOffset)
    else if (matchesKey(data, Key.down)) this.setOffset(this.offset + 1, maxOffset)
    else if (matchesKey(data, Key.pageUp)) this.setOffset(this.offset - this.visibleRows, maxOffset)
    else if (matchesKey(data, Key.pageDown)) this.setOffset(this.offset + this.visibleRows, maxOffset)
    else if (matchesKey(data, Key.home)) this.setOffset(0, maxOffset)
    else if (matchesKey(data, Key.end)) this.setOffset(maxOffset, maxOffset)
  }

  invalidate(): void {
    this.renderedLines = undefined
    this.renderedWidth = undefined
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const innerWidth = Math.max(1, safeWidth - 2 * this.paddingX)
    this.ensureRendered(innerWidth)
    const lines = this.renderedLines ?? []
    const maxOffset = Math.max(0, lines.length - this.visibleRows)
    const safeOffset = Math.max(0, Math.min(this.offset, maxOffset))
    const slice = lines.slice(safeOffset, safeOffset + this.visibleRows)

    const padding = ' '.repeat(this.paddingX)
    const padLineX = (text: string): string => padLine(`${padding}${text}${padding}`, safeWidth)
    const blank = padLine('', safeWidth)

    const aboveCount = safeOffset
    const belowCount = Math.max(0, lines.length - (safeOffset + this.visibleRows))
    const aboveLine = aboveCount > 0 ? padLineX(this.theme.fg('dim', `↑ ${aboveCount} more`)) : undefined
    const belowLine = belowCount > 0 ? padLineX(this.theme.fg('dim', `↓ ${belowCount} more`)) : undefined

    const body: string[] = []
    if (aboveLine) body.push(aboveLine)
    for (const line of slice) body.push(padLineX(line))
    // Pad the visible window to a stable height so the help line doesn't jitter.
    for (let i = slice.length; i < this.visibleRows; i++) body.push(blank)
    if (belowLine) body.push(belowLine)
    return body
  }

  private setOffset(next: number, maxOffset: number): void {
    const clamped = Math.max(0, Math.min(next, maxOffset))
    if (clamped === this.offset) return
    this.offset = clamped
  }

  private ensureRendered(innerWidth: number): void {
    if (this.renderedLines !== undefined && this.renderedWidth === innerWidth) return
    const md = new Markdown(this.markdown, 0, 0, this.markdownTheme)
    this.renderedLines = md.render(innerWidth)
    this.renderedWidth = innerWidth
    const maxOffset = Math.max(0, this.renderedLines.length - this.visibleRows)
    if (this.offset > maxOffset) this.offset = maxOffset
  }
}

export function resolveMarkdownTheme(): MarkdownTheme {
  try {
    const theme = getMarkdownTheme()
    theme.heading('probe')
    return theme
  } catch {
    const identity = (text: string) => text
    return {
      heading: identity,
      link: identity,
      linkUrl: identity,
      code: identity,
      codeBlock: identity,
      codeBlockBorder: identity,
      quote: identity,
      quoteBorder: identity,
      hr: identity,
      listBullet: identity,
      bold: identity,
      italic: identity,
      strikethrough: identity,
      underline: identity
    }
  }
}

const MARKDOWN_FOOTER_KEYS = [
  { key: '↑↓', label: 'scroll' },
  { key: 'PgUp/PgDn', label: 'page' },
  { key: 'Home/End', label: 'jump' },
  { key: 'Esc', label: 'close' },
  { key: 'Ctrl-C', label: 'close' }
] as const

class MarkdownOverlayChrome implements DialogContent {
  constructor(
    private readonly theme: Theme,
    private readonly title: string,
    private readonly body: MarkdownOverlayBody
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    return [
      renderDialogHeader({
        title: this.title,
        theme: this.theme,
        width: safeWidth
      }),
      renderDialogDivider({ theme: this.theme, width: safeWidth }),
      ...this.body.render(safeWidth),
      renderDialogDivider({ theme: this.theme, width: safeWidth }),
      renderDialogFooter({
        theme: this.theme,
        width: safeWidth,
        keys: MARKDOWN_FOOTER_KEYS
      })
    ]
  }

  invalidate(): void {
    this.body.invalidate()
  }

  handleInput(data: string): void {
    this.body.handleInput(data)
  }
}

export function showMarkdownOverlay(ctx: ExtensionCommandContext, options: MarkdownOverlayOptions): OverlayHandle {
  const visibleRows = options.visibleRows ?? DEFAULT_VISIBLE_ROWS
  const paddingX = options.paddingX ?? DEFAULT_PADDING_X
  return openDialog(
    ctx,
    ({ theme, close }) =>
      new MarkdownOverlayChrome(
        theme,
        options.title,
        new MarkdownOverlayBody(theme, options.markdown, close, visibleRows, paddingX)
      ),
    {
      width: options.width ?? '96%',
      maxHeight: options.maxHeight ?? '94%',
      padding: 0,
      borderStyle: 'square'
    }
  )
}

// Re-export OverlayHandle for spec/commands.ts and other markdown overlay consumers.
export type { OverlayHandle }
