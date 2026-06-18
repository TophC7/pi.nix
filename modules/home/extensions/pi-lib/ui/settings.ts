import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent'
import { Input, Key, matchesKey, type SettingItem, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import {
  type DialogContent,
  type DialogOptions,
  openDialog,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader
} from './dialog.ts'

// ABOUT: Shared searchable settings dialog. Modeled directly on
// pi-tool-display's SplitPaneInspectorModal: the body itself renders
// header / divider / split-pane / divider / footer rows; the surrounding
// DialogFrame is a plain square border. List on the left, inspector pane
// on the right, with a `┬`-joined divider between header / panes / footer.

const SPLIT_MIN_WIDTH = 84
const LIST_MIN_WIDTH = 28
const INSPECTOR_MIN_WIDTH = 36
const BODY_ROW_MIN = 14
const BODY_ROW_MAX = 28
const FOOTER_KEYS = [
  { key: 'Space/Enter', label: 'toggle' },
  { key: '↑↓', label: 'navigate' },
  { key: 'type', label: 'search' },
  { key: 'Esc', label: 'close' }
] as const

export interface SettingsPaneItem extends SettingItem {
  readonly detailTitle?: string
  readonly detailSummary?: readonly string[]
  readonly detailOptions?: readonly string[]
  readonly detailAdvanced?: readonly string[]
  readonly detailPath?: string
  readonly searchTerms?: readonly string[]
}

export interface SettingsPaneOptions {
  readonly title: string
  readonly description?: string | readonly string[]
  readonly items: readonly SettingsPaneItem[]
  readonly onChange: (id: string, newValue: string) => void
  readonly footer?: readonly { key: string; label: string }[]
  readonly overlay?: DialogOptions
}

interface PaneWidths {
  list: number
  inspector: number
}

export function showSettingsPane(ctx: ExtensionCommandContext, options: SettingsPaneOptions) {
  return openDialog(ctx, ({ theme, close }) => new SettingsDialogBody(theme, options, close), {
    width: '96%',
    maxHeight: '90%',
    minWidth: 60,
    padding: 0,
    borderStyle: 'square',
    ...options.overlay
  })
}

class SettingsDialogBody implements DialogContent {
  private readonly searchInput = new Input()
  private readonly items: SettingsPaneItem[]
  private selectedId: string | undefined

  constructor(
    private readonly theme: Theme,
    private readonly options: SettingsPaneOptions,
    private readonly close: () => void
  ) {
    this.searchInput.focused = true
    this.items = options.items.map((item) => ({ ...item }))
    this.selectedId = this.items[0]?.id
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const items = this.filteredItems()
    this.ensureSelection(items)
    const bodyRows = rowBudget()
    const header = renderDialogHeader({
      title: this.options.title,
      theme: this.theme,
      width: safeWidth,
      searchInput: this.searchInput
    })
    const footer = renderDialogFooter({
      theme: this.theme,
      width: safeWidth,
      keys: this.options.footer ?? FOOTER_KEYS,
      status: this.statusLine(items)
    })

    if (safeWidth < SPLIT_MIN_WIDTH) {
      return [
        header,
        renderDialogDivider({ theme: this.theme, width: safeWidth }),
        ...this.listLines(items, safeWidth, Math.max(6, Math.floor(bodyRows / 2))),
        renderDialogDivider({ theme: this.theme, width: safeWidth }),
        ...this.inspectorLines(this.selectedItem(items), safeWidth, bodyRows),
        renderDialogDivider({ theme: this.theme, width: safeWidth }),
        footer
      ]
    }

    const widths = splitWidths(safeWidth)
    const listLines = this.listLines(items, widths.list, bodyRows)
    const inspectorLines = this.inspectorLines(this.selectedItem(items), widths.inspector, bodyRows)
    const vertical = this.theme.fg('dim', '│')
    const lines: string[] = [
      header,
      renderDialogDivider({
        theme: this.theme,
        width: safeWidth,
        splitAt: widths.list
      })
    ]
    for (let index = 0; index < bodyRows; index += 1) {
      lines.push(
        `${listLines[index] ?? ' '.repeat(widths.list)}${vertical}${inspectorLines[index] ?? ' '.repeat(widths.inspector)}`
      )
    }
    lines.push(
      renderDialogDivider({
        theme: this.theme,
        width: safeWidth,
        splitAt: widths.list
      })
    )
    lines.push(footer)
    return lines
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.close()
      return
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.move(1)
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === ' ') {
      this.cycle(1)
      return
    }
    this.searchInput.handleInput(data)
    this.ensureSelection(this.filteredItems())
  }

  private statusLine(items: readonly SettingsPaneItem[]): string | undefined {
    if (items.length === 0) return 'no match'
    return `${items.length}/${this.items.length}`
  }

  private filteredItems(): SettingsPaneItem[] {
    const query = this.searchInput.getValue().trim().toLowerCase()
    if (!query) return this.items
    return this.items.filter((item) => {
      const haystack = [
        item.label,
        item.currentValue,
        item.detailTitle,
        ...(item.detailSummary ?? []),
        ...(item.detailOptions ?? []),
        ...(item.detailAdvanced ?? []),
        ...(item.searchTerms ?? [])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }

  private ensureSelection(items: readonly SettingsPaneItem[]): void {
    if (items.length === 0) {
      this.selectedId = undefined
      return
    }
    if (this.selectedId && items.some((item) => item.id === this.selectedId)) return
    this.selectedId = items[0]?.id
  }

  private move(delta: number): void {
    const items = this.filteredItems()
    if (items.length === 0) return
    this.ensureSelection(items)
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === this.selectedId)
    )
    this.selectedId = items[(index + delta + items.length) % items.length]?.id
  }

  private cycle(direction: -1 | 1): void {
    const item = this.selectedItem(this.filteredItems())
    if (!item?.values?.length) return
    const currentIndex = Math.max(0, item.values.indexOf(item.currentValue))
    const nextValue = item.values[(currentIndex + direction + item.values.length) % item.values.length]
    if (!nextValue || nextValue === item.currentValue) return
    item.currentValue = nextValue
    this.options.onChange(item.id, nextValue)
  }

  private selectedItem(items: readonly SettingsPaneItem[]): SettingsPaneItem | undefined {
    this.ensureSelection(items)
    return items.find((item) => item.id === this.selectedId)
  }

  private listLines(items: readonly SettingsPaneItem[], width: number, rowCount: number): string[] {
    const safeWidth = Math.max(1, width)
    if (items.length === 0) {
      return padRows(
        [
          this.theme.fg('warning', fit('No matching settings.', safeWidth)),
          this.theme.fg('dim', fit('Backspace in search to widen filter.', safeWidth))
        ],
        rowCount,
        safeWidth
      )
    }
    const selectedIndex = Math.max(
      0,
      items.findIndex((item) => item.id === this.selectedId)
    )
    const visible = scrollWindow(items, selectedIndex, rowCount)
    const maxValueWidth = Math.max(6, ...visible.map((item) => visibleWidth(item.currentValue)))
    const valueWidth = clamp(maxValueWidth, 6, Math.max(6, Math.floor(safeWidth * 0.34)))
    const labelWidth = Math.max(8, safeWidth - valueWidth - 3)
    return padRows(
      visible.map((item) => this.settingRow(item, safeWidth, labelWidth, valueWidth)),
      rowCount,
      safeWidth
    )
  }

  private settingRow(item: SettingsPaneItem, width: number, labelWidth: number, valueWidth: number): string {
    const selected = item.id === this.selectedId
    const cursor = selected ? this.theme.fg('accent', this.theme.bold('>')) : ' '
    const label = selected ? this.theme.bold(fit(item.label, labelWidth)) : fit(item.label, labelWidth)
    const value = selected
      ? this.theme.fg('accent', fit(item.currentValue, valueWidth))
      : this.theme.fg('muted', fit(item.currentValue, valueWidth))
    return truncateToWidth(`${cursor} ${label} ${value}`, width, '', true)
  }

  private inspectorLines(item: SettingsPaneItem | undefined, width: number, rowCount: number): string[] {
    const safeWidth = Math.max(1, width)
    if (!item) {
      return padRows(
        [
          this.theme.fg('accent', fit(' [ Search ]', safeWidth)),
          '',
          ...this.wrapped([' No settings matched current filter.'], safeWidth, 'muted')
        ],
        rowCount,
        safeWidth
      )
    }
    const top = [this.theme.fg('accent', fit(` [ ${item.detailTitle ?? item.label} ]`, safeWidth)), '']
    top.push(
      ...this.wrapped(
        item.detailSummary ?? ['Cycle available values with Space, Enter, or arrow keys.'],
        safeWidth,
        'muted'
      )
    )
    if ((item.detailAdvanced?.length ?? 0) > 0) {
      top.push('', this.theme.fg('accent', fit(' Advanced:', safeWidth)))
      top.push(...this.bullets(item.detailAdvanced ?? [], safeWidth, 'dim'))
    }
    if ((item.detailOptions?.length ?? 0) > 0) {
      top.push('', this.theme.fg('dim', fit(' Options:', safeWidth)))
      top.push(...this.bullets(item.detailOptions ?? [], safeWidth, 'muted'))
    }
    const bottom: string[] = []
    if (item.detailPath)
      bottom.push(
        this.theme.fg('dim', fit(' Path:', safeWidth)),
        this.theme.fg('muted', fit(` ${item.detailPath}`, safeWidth))
      )
    return composeRows(top, bottom, rowCount, safeWidth)
  }

  private wrapped(paragraphs: readonly string[], width: number, color: 'muted' | 'dim'): string[] {
    const inner = Math.max(1, width - 1)
    return paragraphs.flatMap((paragraph) =>
      wrapText(paragraph, inner).map((line) => this.theme.fg(color, fit(` ${line}`, width)))
    )
  }

  private bullets(lines: readonly string[], width: number, color: 'muted' | 'dim'): string[] {
    const inner = Math.max(1, width - 3)
    return lines.flatMap((line) =>
      wrapText(line, inner).map((part, index) =>
        this.theme.fg(color, fit(`${index === 0 ? ' • ' : '   '}${part}`, width))
      )
    )
  }
}

function splitWidths(width: number): PaneWidths {
  const usable = Math.max(LIST_MIN_WIDTH + INSPECTOR_MIN_WIDTH, width - 1)
  const preferredList = Math.floor(usable * 0.38)
  const list = clamp(preferredList, LIST_MIN_WIDTH, Math.max(LIST_MIN_WIDTH, usable - INSPECTOR_MIN_WIDTH))
  return { list, inspector: Math.max(INSPECTOR_MIN_WIDTH, usable - list) }
}

function rowBudget(): number {
  const rows =
    typeof process.stdout.rows === 'number' && Number.isFinite(process.stdout.rows) ? process.stdout.rows : 36
  return clamp(Math.floor(rows * 0.55), BODY_ROW_MIN, BODY_ROW_MAX)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fit(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width), '…', true)
  const remaining = Math.max(0, width - visibleWidth(truncated))
  return `${truncated}${' '.repeat(remaining)}`
}

function scrollWindow<T>(items: readonly T[], selectedIndex: number, visibleRows: number): readonly T[] {
  if (items.length <= visibleRows) return items
  const half = Math.floor(visibleRows / 2)
  const start = clamp(selectedIndex - half, 0, Math.max(0, items.length - visibleRows))
  return items.slice(start, start + visibleRows)
}

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (visibleWidth(candidate) <= safeWidth) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = visibleWidth(word) <= safeWidth ? word : truncateToWidth(word, safeWidth, '…', true)
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

function padRows(lines: readonly string[], rowCount: number, width: number): string[] {
  const padded = [...lines]
  while (padded.length < rowCount) padded.push(' '.repeat(width))
  return padded.slice(0, rowCount)
}

function composeRows(top: string[], bottom: string[], rowCount: number, width: number): string[] {
  if (bottom.length === 0) return padRows(top, rowCount, width)
  if (top.length + bottom.length <= rowCount)
    return [
      ...top,
      ...Array.from({ length: rowCount - top.length - bottom.length }, () => ' '.repeat(width)),
      ...bottom
    ]
  const keep = Math.max(1, rowCount - bottom.length - 1)
  return [...top.slice(0, keep), fit('…', width), ...bottom].slice(0, rowCount)
}
