import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import {
  type DialogContent,
  fitLine,
  formatTokens,
  MarkdownOverlayBody,
  padLine,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader
} from '@pi/lib/ui'
import type { BurdenReport } from './types.ts'
import { type BurdenRowView, type BurdenViewModel, buildBurdenViewModel } from './view-model.ts'

const MAX_PREVIEW_BYTES = 256 * 1024

// ABOUT: Burden explorer with split-pane layout (tree left, detail right).
// Pane ratio adapts to width: 2/3 tree on wide terminals, 1/2 on narrower,
// stacked when too narrow to keep both sides legible. Tree rows render
// connector / label / inline-bar / token-count with a fixed right gutter
// so nothing can spill past the pane width.

export interface BurdenExplorerOptions {
  readonly report: BurdenReport
  readonly theme: Theme
  readonly onClose: () => void
}

interface PreviewState {
  readonly row: BurdenRowView
  readonly body: MarkdownOverlayBody
}

interface TreeRowMeta {
  readonly isLast: boolean
  readonly ancestorMask: readonly boolean[]
}

interface PaneWidths {
  readonly tree: number
  readonly detail: number
  readonly stacked: boolean
}

const SPLIT_MIN_WIDTH = 84
const WIDE_SPLIT_WIDTH = 120
const BAR_WIDTH = 14
const TOKEN_WIDTH = 7
const RIGHT_GUTTER = 2

const FOOTER_KEYS_TABLE = [
  { key: '↑↓', label: 'move' },
  { key: 'Enter', label: 'preview' },
  { key: '→', label: 'expand' },
  { key: '←', label: 'collapse' },
  { key: 'type', label: 'search' },
  { key: 'Esc', label: 'clear' },
  { key: 'Ctrl-C', label: 'close' }
] as const

const FOOTER_KEYS_PREVIEW = [
  { key: '↑↓', label: 'scroll' },
  { key: 'PgUp/PgDn', label: 'page' },
  { key: 'Home/End', label: 'jump' },
  { key: 'Esc', label: 'back' },
  { key: 'Ctrl-C', label: 'close' }
] as const

export class BurdenExplorer implements DialogContent {
  private readonly view: BurdenViewModel
  private readonly expanded = new Set<string>()
  private readonly searchInput = new Input()
  private selectedId: string | undefined
  private scrollOffset = 0
  private preview: PreviewState | undefined
  private status = ''
  private lastQuery = ''

  constructor(private readonly options: BurdenExplorerOptions) {
    this.searchInput.focused = true
    this.view = buildBurdenViewModel(options.report)
    for (const section of this.view.sections.slice(0, 4)) this.expanded.add(section.rowId)
    this.selectedId = this.visibleRows()[0]?.id
  }

  render(width: number): string[] {
    const safeWidth = Math.max(40, width)
    if (this.preview) return this.previewBody(safeWidth)
    return this.tableBody(safeWidth)
  }

  invalidate(): void {
    this.preview?.body.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.options.onClose()
      return
    }
    if (this.preview) {
      this.preview.body.handleInput(data)
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
    if (matchesKey(data, Key.enter)) {
      this.previewSelected()
      return
    }
    if (matchesKey(data, Key.right)) {
      this.expandSelected()
      return
    }
    if (matchesKey(data, Key.left)) {
      this.collapseSelected()
      return
    }
    if (matchesKey(data, Key.escape)) {
      if (this.searchInput.getValue().length > 0) {
        this.searchInput.setValue('')
        this.lastQuery = ''
        this.scrollOffset = 0
        this.ensureSelection()
        this.status = 'Search cleared.'
      } else {
        this.status = 'Ctrl-C closes burden.'
      }
      return
    }
    this.searchInput.handleInput(data)
    this.syncQuery()
  }

  private tableBody(width: number): string[] {
    const panes = computePaneWidths(width)
    const bodyRows = rowBudget()
    const visibleRows = this.visibleRows()
    this.ensureSelection(visibleRows)
    const isSearching = this.lastQuery.trim().length > 0
    const treeMeta = isSearching ? new Map<string, TreeRowMeta>() : computeTreeMeta(visibleRows, this.view)
    const selectedIndex = Math.max(
      0,
      visibleRows.findIndex((row) => row.id === this.selectedId)
    )
    this.scrollOffset = clampScroll(this.scrollOffset, selectedIndex, visibleRows.length, bodyRows)

    const treeLines = this.renderTreeLines(visibleRows, treeMeta, panes.tree, bodyRows, isSearching)
    const detailLines = this.renderDetailLines(this.selectedRow(visibleRows), panes.detail, bodyRows)
    const header = renderDialogHeader({
      title: this.title(),
      theme: this.options.theme,
      width,
      searchInput: this.searchInput
    })
    const footer = renderDialogFooter({
      theme: this.options.theme,
      width,
      keys: FOOTER_KEYS_TABLE,
      status: this.status || this.summary(visibleRows.length)
    })

    const lines: string[] = [header]

    if (panes.stacked) {
      lines.push(renderDialogDivider({ theme: this.options.theme, width }))
      const half = Math.max(6, Math.floor(bodyRows / 2))
      const treePadded = padRows(treeLines.slice(0, half), half, panes.tree)
      const detailPadded = padRows(detailLines.slice(0, bodyRows - half), bodyRows - half, panes.detail)
      for (const line of treePadded) lines.push(line)
      lines.push(renderDialogDivider({ theme: this.options.theme, width }))
      for (const line of detailPadded) lines.push(line)
    } else {
      lines.push(
        renderDialogDivider({
          theme: this.options.theme,
          width,
          splitAt: panes.tree
        })
      )
      const vertical = this.options.theme.fg('dim', '│')
      for (let i = 0; i < bodyRows; i += 1) {
        const left = treeLines[i] ?? ' '.repeat(panes.tree)
        const right = detailLines[i] ?? ' '.repeat(panes.detail)
        lines.push(`${left}${vertical}${right}`)
      }
      lines.push(
        renderDialogDivider({
          theme: this.options.theme,
          width,
          splitAt: panes.tree
        })
      )
    }
    lines.push(footer)
    return lines
  }

  private previewBody(width: number): string[] {
    if (!this.preview) return []
    const header = renderDialogHeader({
      title: `Preview — ${this.preview.row.label}`,
      theme: this.options.theme,
      width
    })
    const footer = renderDialogFooter({
      theme: this.options.theme,
      width,
      keys: FOOTER_KEYS_PREVIEW
    })
    return [
      header,
      renderDialogDivider({ theme: this.options.theme, width }),
      ...this.preview.body.render(width),
      renderDialogDivider({ theme: this.options.theme, width }),
      footer
    ]
  }

  private renderTreeLines(
    rows: readonly BurdenRowView[],
    meta: ReadonlyMap<string, TreeRowMeta>,
    paneWidth: number,
    rowCount: number,
    isSearching: boolean
  ): string[] {
    if (rows.length === 0) {
      return padRows([this.options.theme.fg('dim', fit(' No rows match search.', paneWidth))], rowCount, paneWidth)
    }
    const window = rows.slice(this.scrollOffset, this.scrollOffset + rowCount)
    const lines = window.map((row) =>
      isSearching
        ? this.renderSearchRow(row, paneWidth)
        : this.renderTreeRow(row, meta.get(row.id) ?? { isLast: true, ancestorMask: [] }, paneWidth)
    )
    return padRows(lines, rowCount, paneWidth)
  }

  private renderTreeRow(row: BurdenRowView, meta: TreeRowMeta, paneWidth: number): string {
    const indent = meta.ancestorMask.map((isLast) => (isLast ? '   ' : '│  ')).join('')
    const connector = this.connectorFor(row, meta)
    const prefix = ` ${indent}${connector}`
    return this.composeTreeRow(row, prefix, paneWidth)
  }

  private renderSearchRow(row: BurdenRowView, paneWidth: number): string {
    const breadcrumb = this.breadcrumbFor(row)
    const prefix = ` ${breadcrumb ? `${breadcrumb} › ` : ''}`
    return this.composeTreeRow(row, prefix, paneWidth)
  }

  private composeTreeRow(row: BurdenRowView, prefix: string, paneWidth: number): string {
    const theme = this.options.theme
    const prefixWidth = visibleWidth(prefix)
    // Total row width = cursor(1) + prefix + label + gutter(RIGHT_GUTTER) + bar(BAR_WIDTH) + 1 + tokens(TOKEN_WIDTH) + trailing(1)
    const FIXED = 1 + RIGHT_GUTTER + BAR_WIDTH + 1 + TOKEN_WIDTH + 1
    const labelWidth = Math.max(4, paneWidth - prefixWidth - FIXED)
    const selected = row.id === this.selectedId
    const ratio = this.view.totalTokens > 0 ? row.tokens / this.view.totalTokens : 0
    const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(ratio * BAR_WIDTH)))
    const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
    const tokens = formatTokens(row.tokens).padStart(TOKEN_WIDTH, ' ')
    const labelText = fit(row.label, labelWidth)

    const styledPrefix = theme.fg(selected ? 'accent' : 'dim', prefix)
    const styledLabel = selected ? theme.fg('accent', theme.bold(labelText)) : labelText
    const styledBar = selected ? theme.fg('accent', bar) : theme.fg('dim', bar)
    const styledTokens = selected ? theme.fg('accent', theme.bold(tokens)) : theme.fg('muted', tokens)
    const cursor = selected ? theme.fg('accent', '▌') : ' '

    return `${cursor}${styledPrefix}${styledLabel}${' '.repeat(RIGHT_GUTTER)}${styledBar} ${styledTokens} `
  }

  private connectorFor(row: BurdenRowView, meta: TreeRowMeta): string {
    if (row.depth === 0) {
      if (row.hasChildren) return this.expanded.has(row.id) ? '▾ ' : '▸ '
      return '  '
    }
    if (row.hasChildren) {
      const fold = this.expanded.has(row.id) ? '▾' : '▸'
      return `${meta.isLast ? '└' : '├'}${fold} `
    }
    return `${meta.isLast ? '└' : '├'}─ `
  }

  private breadcrumbFor(row: BurdenRowView): string {
    const parts: string[] = []
    let parentId = row.parentId
    while (parentId) {
      const parent = this.view.rowsById.get(parentId)
      if (!parent) break
      parts.unshift(parent.label)
      parentId = parent.parentId
    }
    return parts.join(' › ')
  }

  private renderDetailLines(row: BurdenRowView | undefined, paneWidth: number, rowCount: number): string[] {
    const safeWidth = Math.max(1, paneWidth)
    const theme = this.options.theme
    const contentWidth = Math.max(1, safeWidth - 2)
    const lines: string[] = []
    const blank = ' '.repeat(safeWidth)

    if (!row) {
      return padRows([blank, `  ${theme.fg('dim', 'Select a row to see details.')}`], rowCount, safeWidth)
    }

    const total = this.view.totalTokens
    const ctx = this.view.contextWindow
    const pctUsed = total > 0 ? row.tokens / total : 0
    const pctCtx = ctx ? row.tokens / ctx : undefined
    const breadcrumb = this.breadcrumbFor(row)

    lines.push(blank)
    lines.push(this.padPane(` ${theme.fg('accent', theme.bold(`[ ${row.label} ]`))}`, safeWidth))
    if (breadcrumb)
      lines.push(this.padPane(`  ${theme.fg('dim', truncateToWidth(breadcrumb, contentWidth, '…', true))}`, safeWidth))
    lines.push(blank)
    lines.push(this.padPane(`  ${theme.fg('muted', `${formatTokens(row.tokens)} tokens`)}`, safeWidth))
    lines.push(
      this.padPane(
        `  ${theme.fg('dim', `${percent(pctUsed)} of used${pctCtx !== undefined ? ` · ${percent(pctCtx)} of context` : ''}`)}`,
        safeWidth
      )
    )
    lines.push(this.padPane(`  ${theme.fg('dim', `kind: ${row.kind}`)}`, safeWidth))
    lines.push(blank)

    const source = row.source
    if (source) {
      lines.push(this.padPane(`  ${theme.fg('muted', 'Source')}`, safeWidth))
      if (source.name)
        lines.push(
          this.padPane(`  ${theme.fg('dim', truncateToWidth(source.name, contentWidth, '…', true))}`, safeWidth)
        )
      if (source.path)
        lines.push(
          this.padPane(`  ${theme.fg('dim', truncateToWidth(source.path, contentWidth, '…', true))}`, safeWidth)
        )
      lines.push(blank)
    }

    if (row.hasChildren) {
      lines.push(
        this.padPane(
          `  ${theme.fg('muted', `${row.childIds.length} child${row.childIds.length === 1 ? '' : 'ren'}`)}`,
          safeWidth
        )
      )
      lines.push(
        this.padPane(
          `  ${theme.fg('dim', this.expanded.has(row.id) ? '→ collapse to hide' : '→ expand to inspect')}`,
          safeWidth
        )
      )
      lines.push(blank)
    }

    const previewable = row.actions.openSnapshot || row.actions.openSource
    if (previewable) {
      lines.push(this.padPane(`  ${theme.fg('dim', '↵ Enter to preview content')}`, safeWidth))
    } else {
      lines.push(this.padPane(`  ${theme.fg('dim', 'No preview available')}`, safeWidth))
    }

    return padRows(lines, rowCount, safeWidth)
  }

  private padPane(text: string, width: number): string {
    return padLine(fitLine(text, width), width)
  }

  private title(): string {
    const used = formatTokens(this.view.totalTokens)
    const ctx = this.view.contextWindow ? ` / ${formatTokens(this.view.contextWindow)}` : ''
    const pct = this.view.contextPercent !== undefined ? ` · ${percent(this.view.contextPercent)}` : ''
    return `Burden  ${used}${ctx} tokens${pct}`
  }

  private summary(rowCount: number): string {
    const total = this.view.rows.length
    if (this.lastQuery.trim()) return `${rowCount} match${rowCount === 1 ? '' : 'es'} / ${total} rows`
    return `${rowCount} of ${total} rows`
  }

  private move(delta: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) return
    const currentIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selectedId)
    )
    const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + delta))
    this.selectedId = rows[nextIndex]?.id
    this.status = ''
  }

  private previewSelected(): void {
    const row = this.selectedRow()
    if (!row) return
    const preview = this.previewForRow(row)
    if (preview) {
      this.preview = {
        row,
        body: new MarkdownOverlayBody(
          this.options.theme,
          preview.markdown,
          () => {
            this.preview = undefined
            this.status = `Back from preview: ${row.label}`
          },
          this.previewRowBudget(),
          1
        )
      }
      return
    }
    if (row.hasChildren) this.toggleExpanded(row)
    else this.status = 'No generated content or source file for selected row.'
  }

  private previewForRow(row: BurdenRowView): { title: string; markdown: string } | undefined {
    if (row.actions.openSnapshot) {
      return { title: row.label, markdown: row.actions.openSnapshot.content }
    }
    const sourcePath = row.actions.openSource?.path
    if (!sourcePath) return undefined
    try {
      const stats = statSync(sourcePath)
      if (stats.size > MAX_PREVIEW_BYTES) {
        const kb = Math.round(stats.size / 1024)
        const limitKb = MAX_PREVIEW_BYTES / 1024
        const markdown = [
          `# ${row.label}`,
          '',
          `Source: \`${sourcePath}\``,
          '',
          `_Preview omitted — file is ${kb} KB (limit ${limitKb} KB). Open externally._`
        ].join('\n')
        return { title: sourcePath, markdown }
      }
      const content = readFileSync(sourcePath, 'utf8')
      return {
        title: sourcePath,
        markdown: sourceMarkdown(row, sourcePath, content)
      }
    } catch (error) {
      this.status = `Failed to read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
      return undefined
    }
  }

  private expandSelected(): void {
    const row = this.selectedRow()
    if (!row?.hasChildren) {
      this.status = 'Selected row has no children.'
      return
    }
    this.expanded.add(row.id)
    this.status = `Expanded ${row.label}.`
  }

  private collapseSelected(): void {
    const row = this.selectedRow()
    if (!row?.hasChildren || !this.expanded.has(row.id)) {
      this.status = 'Selected row is not expanded.'
      return
    }
    this.expanded.delete(row.id)
    this.status = `Collapsed ${row.label}.`
  }

  private toggleExpanded(row: BurdenRowView): void {
    if (this.expanded.has(row.id)) this.expanded.delete(row.id)
    else this.expanded.add(row.id)
    this.status = `${this.expanded.has(row.id) ? 'Expanded' : 'Collapsed'} ${row.label}.`
  }

  private visibleRows(): BurdenRowView[] {
    const query = this.lastQuery.trim().toLowerCase()
    if (query) {
      return this.view.rows.filter((row) => row.searchText.toLowerCase().includes(query))
    }
    return this.view.rows.filter((row) => this.isAncestorExpanded(row))
  }

  private isAncestorExpanded(row: BurdenRowView): boolean {
    let parentId = row.parentId
    while (parentId) {
      if (!this.expanded.has(parentId)) return false
      parentId = this.view.rowsById.get(parentId)?.parentId
    }
    return true
  }

  private syncQuery(): void {
    const value = this.searchInput.getValue()
    if (value === this.lastQuery) return
    this.lastQuery = value
    this.scrollOffset = 0
    this.ensureSelection()
  }

  private ensureSelection(rows?: readonly BurdenRowView[]): void {
    const list = rows ?? this.visibleRows()
    if (list.length === 0) {
      this.selectedId = undefined
      return
    }
    if (this.selectedId && list.some((row) => row.id === this.selectedId)) return
    this.selectedId = list[0]?.id
  }

  private selectedRow(rows?: readonly BurdenRowView[]): BurdenRowView | undefined {
    const list = rows ?? this.visibleRows()
    if (!this.selectedId) return list[0]
    return list.find((row) => row.id === this.selectedId)
  }

  private previewRowBudget(): number {
    const rows = terminalRows()
    return clamp(Math.floor(rows * 0.7), 18, 40)
  }
}

function computePaneWidths(width: number): PaneWidths {
  if (width < SPLIT_MIN_WIDTH) return { tree: width, detail: width, stacked: true }
  const ratio = width >= WIDE_SPLIT_WIDTH ? 2 / 3 : 1 / 2
  const tree = Math.max(40, Math.floor(width * ratio))
  const detail = Math.max(20, width - tree - 1)
  return { tree, detail, stacked: false }
}

function computeTreeMeta(rows: readonly BurdenRowView[], view: BurdenViewModel): Map<string, TreeRowMeta> {
  const byParent = new Map<string, BurdenRowView[]>()
  for (const row of rows) {
    const key = row.parentId ?? ''
    const list = byParent.get(key) ?? []
    list.push(row)
    byParent.set(key, list)
  }
  const isLastMap = new Map<string, boolean>()
  for (const siblings of byParent.values()) {
    siblings.forEach((row, index) => isLastMap.set(row.id, index === siblings.length - 1))
  }
  const result = new Map<string, TreeRowMeta>()
  for (const row of rows) {
    const mask: boolean[] = []
    let parentId = row.parentId
    while (parentId) {
      mask.unshift(isLastMap.get(parentId) ?? true)
      parentId = view.rowsById.get(parentId)?.parentId
    }
    result.set(row.id, {
      isLast: isLastMap.get(row.id) ?? true,
      ancestorMask: mask
    })
  }
  return result
}

function clampScroll(currentOffset: number, selectedIndex: number, total: number, visible: number): number {
  if (total <= visible) return 0
  const maxOffset = Math.max(0, total - visible)
  if (selectedIndex < currentOffset) return clamp(selectedIndex, 0, maxOffset)
  if (selectedIndex >= currentOffset + visible) return clamp(selectedIndex - visible + 1, 0, maxOffset)
  return clamp(currentOffset, 0, maxOffset)
}

function rowBudget(): number {
  const rows = terminalRows()
  return clamp(Math.floor(rows * 0.55), 16, 32)
}

function terminalRows(): number {
  return typeof process.stdout.rows === 'number' && Number.isFinite(process.stdout.rows) ? process.stdout.rows : 40
}

function fit(text: string, width: number): string {
  const safeWidth = Math.max(0, width)
  return padLine(fitLine(text, safeWidth), safeWidth)
}

function padRows(lines: readonly string[], rowCount: number, width: number): string[] {
  const padded = [...lines]
  while (padded.length < rowCount) padded.push(' '.repeat(width))
  return padded.slice(0, rowCount)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function percent(value: number): string {
  return `${(Math.round(value * 1000) / 10).toFixed(1)}%`
}

function sourceMarkdown(row: BurdenRowView, sourcePath: string, content: string): string {
  const extension = extname(sourcePath).replace(/^\./, '')
  if (extension === 'md' || extension === 'markdown') {
    return [`# ${row.label}`, '', `Source: \`${sourcePath}\``, '', content].join('\n')
  }
  const fence = content.includes('```') ? '````' : '```'
  return [`# ${row.label}`, '', `Source: \`${sourcePath}\``, '', `${fence}${extension}`, content, fence].join('\n')
}
