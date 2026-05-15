import { Key, matchesKey } from '@mariozechner/pi-tui'
import type { UiComponentLike } from './contracts.ts'
import { fitLine, padLine } from './render.ts'

export type TextStyle = (text: string) => string

export interface PanelOptions {
  readonly title?: string
  readonly help?: string
  readonly border?: boolean
  readonly accent?: TextStyle
  readonly dim?: TextStyle
}

export class Panel implements UiComponentLike {
  constructor(
    private body: readonly string[] | (() => readonly string[]),
    private readonly options: PanelOptions = {}
  ) {}

  setBody(body: readonly string[] | (() => readonly string[])): void {
    this.body = body
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const body = typeof this.body === 'function' ? this.body() : this.body
    const lines: string[] = []
    if (this.options.title) lines.push(this.style(this.options.title, this.options.accent))
    for (const line of body) lines.push(line)
    if (this.options.help) lines.push(this.style(this.options.help, this.options.dim))
    if (!this.options.border) return lines.map((line) => fitLine(line, safeWidth))
    return this.frame(lines, safeWidth)
  }

  invalidate(): void {}

  private frame(lines: readonly string[], width: number): string[] {
    if (width < 4) return lines.map((line) => fitLine(line, width))
    const innerWidth = width - 2
    return [
      `╭${'─'.repeat(innerWidth)}╮`,
      ...lines.map((line) => `│${padLine(line, innerWidth)}│`),
      `╰${'─'.repeat(innerWidth)}╯`
    ]
  }

  private style(text: string, style: TextStyle | undefined): string {
    return style ? style(text) : text
  }
}

export interface ListItem<T> {
  readonly value: T
  readonly label: string
  readonly description?: string
}

export interface ListDialogOptions<T> {
  readonly title: string
  readonly items: readonly ListItem<T>[]
  readonly visibleRows?: number
  readonly initialIndex?: number
  readonly accent?: TextStyle
  readonly dim?: TextStyle
  readonly onSelect?: (value: T) => void
  readonly onCancel?: () => void
}

export class ListDialog<T> implements UiComponentLike {
  private selected = 0
  private offset = 0

  constructor(private readonly options: ListDialogOptions<T>) {
    this.selected = Math.max(0, Math.min(options.items.length - 1, options.initialIndex ?? 0))
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.up)) return this.move(-1)
    if (matchesKey(data, Key.down)) return this.move(1)
    if (matchesKey(data, Key.enter)) return this.select()
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.options.onCancel?.()
      return true
    }
    return false
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.options.visibleRows ?? Math.min(8, this.options.items.length || 1))
    this.syncOffset(rows)
    const visible = this.options.items.slice(this.offset, this.offset + rows)
    const lines = [this.style(this.options.title, this.options.accent)]
    for (let i = 0; i < visible.length; i++) {
      const index = this.offset + i
      const item = visible[i]!
      const prefix = index === this.selected ? '› ' : '  '
      const description = item.description ? this.style(` — ${item.description}`, this.options.dim) : ''
      lines.push(`${prefix}${item.label}${description}`)
    }
    if (this.options.items.length === 0) lines.push(this.style('No items', this.options.dim))
    lines.push(this.style('↑↓ move • enter select • esc cancel', this.options.dim))
    return lines.map((line) => fitLine(line, width))
  }

  invalidate(): void {}

  private move(delta: number): boolean {
    const last = this.options.items.length - 1
    if (last < 0) return false
    const next = Math.max(0, Math.min(last, this.selected + delta))
    if (next === this.selected) return false
    this.selected = next
    return true
  }

  private select(): boolean {
    const item = this.options.items[this.selected]
    if (!item) return false
    this.options.onSelect?.(item.value)
    return true
  }

  private syncOffset(rows: number): void {
    if (this.selected < this.offset) this.offset = this.selected
    else if (this.selected >= this.offset + rows) this.offset = this.selected - rows + 1
  }

  private style(text: string, style: TextStyle | undefined): string {
    return style ? style(text) : text
  }
}
