import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent'
import { Input, Key, matchesKey, type TUI } from '@earendil-works/pi-tui'
import {
  configRowSource,
  getConfigSections,
  getConfigSectionRows,
  type ConfigRegistryRow,
  type ConfigRegistrySection
} from '@pi/lib/config-registry'
import { THINKING_LEVELS, formatRuntimeProfileError, isThinkingLevel } from '@pi/lib/runtime-profile'
import {
  fitLine,
  openDialog,
  padLine,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader,
  renderTabs,
  createListNav,
  type DialogContent
} from '@pi/lib/ui'

const FOOTER_KEYS = [
  { key: '←→', label: 'tab' },
  { key: '↑↓', label: 'setting' },
  { key: 'Enter', label: 'edit' },
  { key: 'd', label: 'default' },
  { key: 'Esc', label: 'close' }
] as const

const MODEL_PICKER_FOOTER = [
  { key: 'type', label: 'filter' },
  { key: '↑↓', label: 'move' },
  { key: 'Enter', label: 'select' },
  { key: 'Esc', label: 'back' }
] as const

const TEXT_FOOTER = [
  { key: 'type', label: 'value' },
  { key: 'Enter', label: 'save' },
  { key: 'Esc', label: 'back' }
] as const

interface ModelChoice {
  readonly value: string
  readonly label: string
  readonly detail: string
}

interface RowValue {
  readonly value?: string
  readonly error?: string
}

type RowValueSnapshot = ReadonlyMap<string, RowValue>

type DialogMode =
  | { readonly kind: 'config' }
  | {
      readonly kind: 'model'
      readonly row: Extract<ConfigRegistryRow, { kind: 'model' }>
      readonly input: Input
      readonly selectedIndex: number
      readonly currentValue?: string
      readonly choices?: readonly ModelChoice[]
      readonly error?: string
    }
  | {
      readonly kind: 'text'
      readonly row: Extract<ConfigRegistryRow, { kind: 'text' }>
      readonly input: Input
      readonly error?: string
    }

type SaveRowResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

export function openConfigDialog(ctx: ExtensionCommandContext): void {
  openDialog(ctx, ({ tui, theme, close }) => new ConfigDialog(ctx, tui, theme, close), {
    width: '96%',
    maxHeight: '90%',
    minWidth: 72,
    padding: 0,
    borderStyle: 'square'
  })
}

class ConfigDialog implements DialogContent {
  private selectedSectionIndex = 0
  private selectedRowIndex = 0
  private mode: DialogMode = { kind: 'config' }
  private status: string | undefined
  private modelChoicesPromise: Promise<readonly ModelChoice[]> | undefined

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly close: () => void
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    if (this.mode.kind === 'model') return this.renderModelPicker(safeWidth, this.mode)
    if (this.mode.kind === 'text') return this.renderTextInput(safeWidth, this.mode)
    return this.renderConfig(safeWidth)
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.mode.kind === 'model') {
      this.handleModelInput(data, this.mode)
      return
    }
    if (this.mode.kind === 'text') {
      this.handleTextInput(data, this.mode)
      return
    }
    this.handleConfigInput(data)
  }

  private sections(): readonly ConfigRegistrySection[] {
    const sections = getConfigSections()
    this.selectedSectionIndex = clamp(this.selectedSectionIndex, 0, Math.max(0, sections.length - 1))
    return sections
  }

  private activeSection(sections = this.sections()): ConfigRegistrySection | undefined {
    return sections[this.selectedSectionIndex]
  }

  private activeRows(): readonly ConfigRegistryRow[] {
    const section = this.activeSection()
    return section ? getConfigSectionRows(section, this.ctx) : []
  }

  private emptySectionLine(section: ConfigRegistrySection | undefined, width: number): string {
    const message = section ? `No config rows registered for ${section.title}.` : 'No config sections registered.'
    return this.theme.fg('muted', padLine(fitLine(message, width), width))
  }

  private renderConfig(width: number): string[] {
    const sections = this.sections()
    const section = this.activeSection(sections)
    const rows = section ? getConfigSectionRows(section, this.ctx) : []
    const header = renderDialogHeader({
      title: 'Config',
      theme: this.theme,
      width
    })
    const tabs = renderTabs({
      tabs: sections.map((entry) => ({ id: entry.id, label: entry.title })),
      activeId: section?.id,
      width,
      theme: this.theme
    })
    const footer = renderDialogFooter({
      theme: this.theme,
      width,
      keys: FOOTER_KEYS,
      status: this.status
    })
    const bodyRows = rowBudget()
    const visibleBudget = Math.max(8, bodyRows - 6)
    const safeIndex = clamp(this.selectedRowIndex, 0, Math.max(0, rows.length - 1))
    this.selectedRowIndex = safeIndex
    const start = windowStart(rows.length, safeIndex, visibleBudget)
    const visibleRowItems = rows.slice(start, start + visibleBudget)
    const values = snapshotRowValues(visibleRowItems, this.ctx)
    const visibleRows = visibleRowItems.map((row, index) =>
      this.configRowLine(row, values, start + index === safeIndex, width)
    )
    const selected = rows[safeIndex]
    const details = selected ? this.detailLines(selected, width) : [this.emptySectionLine(section, width)]
    return [
      header,
      renderDialogDivider({ theme: this.theme, width }),
      tabs,
      renderDialogDivider({ theme: this.theme, width }),
      ...padRows(visibleRows, visibleBudget, width),
      renderDialogDivider({ theme: this.theme, width }),
      ...details,
      renderDialogDivider({ theme: this.theme, width }),
      footer
    ]
  }

  private renderModelPicker(width: number, mode: Extract<DialogMode, { kind: 'model' }>): string[] {
    const choices = mode.choices ? this.filteredModelChoices(mode) : []
    const selectedIndex = clamp(mode.selectedIndex, 0, Math.max(0, choices.length - 1))
    const bodyRows = rowBudget()
    const rows = mode.choices
      ? scrollWindow(choices, selectedIndex, bodyRows).map((choice, index) => {
          const absoluteIndex = windowStart(choices.length, selectedIndex, bodyRows) + index
          return this.modelChoiceLine(choice, absoluteIndex === selectedIndex, mode.currentValue, width)
        })
      : [this.theme.fg('muted', padLine(fitLine('Loading models from configured providers…', width), width))]
    const status = mode.error ?? (mode.choices ? `${choices.length} models` : 'loading')
    return [
      renderDialogHeader({
        title: `${mode.row.label} model`,
        theme: this.theme,
        width,
        searchInput: mode.input
      }),
      renderDialogDivider({ theme: this.theme, width }),
      ...padRows(rows, bodyRows, width),
      renderDialogDivider({ theme: this.theme, width }),
      renderDialogFooter({
        theme: this.theme,
        width,
        keys: MODEL_PICKER_FOOTER,
        status
      })
    ]
  }

  private renderTextInput(width: number, mode: Extract<DialogMode, { kind: 'text' }>): string[] {
    const bodyRows = rowBudget()
    const inputWidth = Math.max(12, width - 2)
    const renderedInput = mode.input.render(inputWidth)[0] ?? '> '
    const rows = [
      this.theme.fg(
        'muted',
        padLine(fitLine(mode.row.description ?? 'Enter a value, or leave empty to clear.', width), width)
      ),
      mode.row.detail ? this.theme.fg('dim', padLine(fitLine(mode.row.detail, width), width)) : '',
      '',
      this.theme.fg('accent', padLine(fitLine(` ${mode.row.fieldLabel ?? 'Value'}`, width), width)),
      padLine(fitLine(renderedInput, width), width)
    ]
    return [
      renderDialogHeader({
        title: `${mode.row.label} ${mode.row.fieldLabel ?? 'value'}`,
        theme: this.theme,
        width
      }),
      renderDialogDivider({ theme: this.theme, width }),
      ...padRows(rows, bodyRows, width),
      renderDialogDivider({ theme: this.theme, width }),
      renderDialogFooter({
        theme: this.theme,
        width,
        keys: TEXT_FOOTER,
        status: mode.error ?? 'Enter saves, Esc backs out'
      })
    ]
  }

  private handleConfigInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.close()
      return
    }
    if (matchesKey(data, Key.left)) {
      this.moveSection(-1)
      return
    }
    if (matchesKey(data, Key.right)) {
      this.moveSection(1)
      return
    }
    if (matchesKey(data, Key.up)) {
      this.moveRow(-1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.moveRow(1)
      return
    }
    if (data === 'd') {
      this.defaultSelectedField()
      return
    }
    if (matchesKey(data, Key.enter) || data === ' ') {
      void this.editSelectedRow()
    }
  }

  private handleModelInput(data: string, mode: Extract<DialogMode, { kind: 'model' }>): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.close()
      return
    }
    if (matchesKey(data, Key.escape)) {
      this.mode = { kind: 'config' }
      this.tui.requestRender()
      return
    }
    if (matchesKey(data, Key.up)) {
      this.moveModelSelection(mode, -1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.moveModelSelection(mode, 1)
      return
    }
    if (matchesKey(data, Key.enter)) {
      const choice = this.filteredModelChoices(mode)[mode.selectedIndex]
      if (choice) this.saveModelChoice(mode.row, choice.value)
      return
    }
    mode.input.handleInput(data)
    this.mode = { ...mode, selectedIndex: 0 }
    this.tui.requestRender()
  }

  private handleTextInput(data: string, mode: Extract<DialogMode, { kind: 'text' }>): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.close()
      return
    }
    if (matchesKey(data, Key.escape)) {
      this.mode = { kind: 'config' }
      this.tui.requestRender()
      return
    }
    if (matchesKey(data, Key.enter)) {
      this.saveTextChoice(mode.row, mode.input.getValue())
      return
    }
    mode.input.handleInput(data)
    this.mode = { ...mode, error: undefined }
    this.tui.requestRender()
  }

  private moveSection(delta: number): void {
    const sections = this.sections()
    const nav = createListNav({ count: sections.length, wrap: true })
    nav.moveTo(this.selectedSectionIndex)
    nav.moveTo(nav.index + delta)
    const nextIndex = nav.index
    const nextStatus = sections[nextIndex]?.title
    if (nextIndex === this.selectedSectionIndex && this.selectedRowIndex === 0 && this.status === nextStatus) return
    this.selectedSectionIndex = nextIndex
    this.selectedRowIndex = 0
    this.status = nextStatus
    this.tui.requestRender()
  }

  private moveRow(delta: number): void {
    const rows = this.activeRows()
    const nextIndex = clamp(this.selectedRowIndex + delta, 0, Math.max(0, rows.length - 1))
    if (nextIndex === this.selectedRowIndex && this.status === undefined) return
    this.selectedRowIndex = nextIndex
    this.status = undefined
    this.tui.requestRender()
  }

  private async editSelectedRow(): Promise<void> {
    const row = this.activeRows()[this.selectedRowIndex]
    if (!row) return
    if (row.kind === 'thinking') {
      this.cycleThinking(row)
      this.tui.requestRender()
      return
    }
    if (row.kind === 'text') {
      this.openTextInput(row)
      return
    }
    await this.openModelPicker(row)
  }

  private openTextInput(row: Extract<ConfigRegistryRow, { kind: 'text' }>): void {
    const input = new Input()
    input.focused = true
    input.setValue?.(safeRowValue(row, this.ctx).value ?? '')
    this.mode = { kind: 'text', row, input }
    this.status = undefined
    this.tui.requestRender()
  }

  private async openModelPicker(row: Extract<ConfigRegistryRow, { kind: 'model' }>): Promise<void> {
    const input = new Input()
    input.focused = true
    const currentValue = safeRowValue(row, this.ctx).value
    this.mode = { kind: 'model', row, input, selectedIndex: 0, currentValue }
    this.status = undefined
    this.tui.requestRender()
    try {
      const choices = await this.loadModelChoices()
      this.mode = {
        kind: 'model',
        row,
        input,
        selectedIndex: this.initialModelIndex(currentValue, choices),
        currentValue,
        choices
      }
    } catch (error) {
      this.modelChoicesPromise = undefined
      this.mode = {
        kind: 'model',
        row,
        input,
        selectedIndex: 0,
        currentValue,
        choices: [
          {
            value: 'default',
            label: 'default',
            detail: 'use current session model'
          }
        ],
        error: formatRuntimeProfileError(error)
      }
    }
    this.tui.requestRender()
  }

  private loadModelChoices(): Promise<readonly ModelChoice[]> {
    this.modelChoicesPromise ??= (async () => {
      this.ctx.modelRegistry.refresh()
      return buildModelChoices(await this.ctx.modelRegistry.getAvailable())
    })()
    return this.modelChoicesPromise
  }

  private initialModelIndex(currentValue: string | undefined, choices: readonly ModelChoice[]): number {
    const current = currentValue ?? 'default'
    if (current === 'default') return 0
    return Math.max(
      0,
      choices.findIndex((choice) => choice.value === current)
    )
  }

  private moveModelSelection(mode: Extract<DialogMode, { kind: 'model' }>, delta: number): void {
    const choices = this.filteredModelChoices(mode)
    if (choices.length === 0) return
    this.mode = {
      ...mode,
      selectedIndex: clamp(mode.selectedIndex + delta, 0, choices.length - 1)
    }
    this.tui.requestRender()
  }

  private saveModelChoice(row: Extract<ConfigRegistryRow, { kind: 'model' }>, selected: string): void {
    const result = this.saveRow(row, selected === 'default' ? undefined : selected)
    if (!result.ok) {
      if (this.mode.kind === 'model') this.mode = { ...this.mode, error: result.error }
      else this.status = result.error
      this.tui.requestRender()
      return
    }
    this.status = `${row.label} model → ${selected}`
    this.mode = { kind: 'config' }
    this.tui.requestRender()
  }

  private saveTextChoice(row: Extract<ConfigRegistryRow, { kind: 'text' }>, value: string): void {
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'default' || trimmed === 'unset' || trimmed === 'clear') {
      const result = this.saveRow(row, undefined)
      if (!result.ok) {
        this.mode = {
          kind: 'text',
          row,
          input: this.mode.kind === 'text' ? this.mode.input : new Input(),
          error: result.error
        }
        this.tui.requestRender()
        return
      }
      this.status = `${row.label} ${row.fieldLabel ?? 'value'} → ${row.unsetLabel ?? 'default'}`
      this.mode = { kind: 'config' }
      this.tui.requestRender()
      return
    }

    const error = row.validate?.(trimmed)
    if (error) {
      this.mode = {
        kind: 'text',
        row,
        input: this.mode.kind === 'text' ? this.mode.input : new Input(),
        error
      }
      this.tui.requestRender()
      return
    }

    const result = this.saveRow(row, trimmed)
    if (!result.ok) {
      this.mode = {
        kind: 'text',
        row,
        input: this.mode.kind === 'text' ? this.mode.input : new Input(),
        error: result.error
      }
      this.tui.requestRender()
      return
    }
    this.status = `${row.label} ${row.fieldLabel ?? 'value'} → ${trimmed}`
    this.mode = { kind: 'config' }
    this.tui.requestRender()
  }

  private cycleThinking(row: Extract<ConfigRegistryRow, { kind: 'thinking' }>): void {
    const current = safeRowValue(row, this.ctx).value ?? 'default'
    const values = ['default', ...THINKING_LEVELS] as const
    const index = Math.max(0, values.indexOf(current as (typeof values)[number]))
    const next = values[(index + 1) % values.length]
    const result = this.saveRow(row, next === 'default' ? undefined : next)
    this.status = result.ok ? `${row.label} thinking → ${next}` : result.error
  }

  private defaultSelectedField(): void {
    const row = this.activeRows()[this.selectedRowIndex]
    if (!row) return
    const result = this.saveRow(row, undefined)
    this.status = result.ok
      ? `${row.label} ${fieldLabel(row)} → ${row.kind === 'text' ? (row.unsetLabel ?? 'unset') : 'default'}`
      : result.error
    this.tui.requestRender()
  }

  private saveRow(row: ConfigRegistryRow, value: string | undefined): SaveRowResult {
    try {
      if (row.kind === 'model') row.set(value, this.ctx)
      else if (row.kind === 'text') row.set(value, this.ctx)
      else {
        const thinking = isThinkingLevel(value) ? value : undefined
        row.set(thinking, this.ctx)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: formatRuntimeProfileError(error) }
    }
  }

  private configRowLine(row: ConfigRegistryRow, values: RowValueSnapshot, selected: boolean, width: number): string {
    const value = values.get(row.id) ?? { error: 'value not loaded' }
    const displayValue = value.error ? `error: ${value.error}` : rowValueLabel(row, value.value)
    const cursor = selected ? this.theme.fg('accent', this.theme.bold('>')) : ' '
    const labelText = row.label.padEnd(12)
    const label = selected ? this.theme.bold(labelText) : labelText
    const field = selected ? this.theme.fg('accent', fieldLabel(row).padEnd(10)) : fieldLabel(row).padEnd(10)
    const renderedValue = value.error
      ? this.theme.fg('error', displayValue)
      : selected
        ? this.theme.fg('accent', displayValue)
        : this.theme.fg('muted', displayValue)
    return padLine(fitLine(`${cursor} ${label} ${field} ${renderedValue}`, width), width)
  }

  private detailLines(row: ConfigRegistryRow, width: number): string[] {
    const source = configRowSource(row, this.ctx)
    const action =
      row.kind === 'model'
        ? 'Enter opens searchable model list.'
        : row.kind === 'thinking'
          ? 'Enter cycles thinking level.'
          : 'Enter edits value.'
    const lines = [
      this.theme.fg('accent', padLine(fitLine(` [ ${row.label} ${fieldLabel(row)} ]`, width), width)),
      this.theme.fg('muted', padLine(fitLine(` ${row.description ?? 'Registered extension setting.'}`, width), width)),
      row.detail ? this.theme.fg('dim', padLine(fitLine(` ${row.detail}`, width), width)) : undefined,
      this.theme.fg('dim', padLine(fitLine(` ${action} d resets this setting.`, width), width)),
      source ? this.theme.fg('dim', padLine(fitLine(` ${source}`, width), width)) : undefined
    ].filter((line): line is string => typeof line === 'string')
    return lines
  }

  private filteredModelChoices(mode: Extract<DialogMode, { kind: 'model' }>): readonly ModelChoice[] {
    const choices = mode.choices ?? []
    const query = mode.input.getValue().trim().toLowerCase()
    if (!query) return choices
    const [defaultChoice, ...models] = choices
    return [
      defaultChoice,
      ...models.filter((choice) => `${choice.value} ${choice.label} ${choice.detail}`.toLowerCase().includes(query))
    ].filter(Boolean)
  }

  private modelChoiceLine(
    choice: ModelChoice,
    selected: boolean,
    currentValue: string | undefined,
    width: number
  ): string {
    const current = choice.value === (currentValue ?? 'default')
    const cursor = selected ? this.theme.fg('accent', this.theme.bold('>')) : ' '
    const flag = current ? this.theme.fg('success', '*') : ' '
    const label = selected ? this.theme.bold(choice.label) : choice.label
    const detail = this.theme.fg('muted', choice.detail)
    return padLine(fitLine(`${cursor}${flag} ${label}  ${detail}`, width), width)
  }
}

function buildModelChoices(models: readonly Model<Api>[]): ModelChoice[] {
  const choices: ModelChoice[] = [{ value: 'default', label: 'default', detail: 'use current session model' }]
  const seen = new Set<string>()
  for (const model of models) {
    const value = `${model.provider}/${model.id}`
    if (seen.has(value)) continue
    seen.add(value)
    choices.push({ value, label: model.name ?? model.id, detail: value })
  }
  return choices
}

function snapshotRowValues(rows: readonly ConfigRegistryRow[], ctx: ExtensionCommandContext): RowValueSnapshot {
  return new Map(rows.map((row) => [row.id, safeRowValue(row, ctx)]))
}

function safeRowValue(row: ConfigRegistryRow, ctx: ExtensionCommandContext): RowValue {
  try {
    return { value: row.get(ctx) }
  } catch (error) {
    return { error: formatRuntimeProfileError(error) }
  }
}

function fieldLabel(row: ConfigRegistryRow): string {
  if (row.kind === 'text') return row.fieldLabel ?? 'value'
  return row.kind
}

function rowValueLabel(row: ConfigRegistryRow, value: string | undefined): string {
  if (!value) return row.kind === 'text' ? (row.unsetLabel ?? 'unset') : 'default'
  if (row.kind !== 'model') return value
  const slash = value.indexOf('/')
  return slash >= 0 ? value.slice(slash + 1) : value
}

function rowBudget(): number {
  const rows =
    typeof process.stdout.rows === 'number' && Number.isFinite(process.stdout.rows) ? process.stdout.rows : 36
  return clamp(Math.floor(rows * 0.55), 12, 26)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function padRows(lines: readonly string[], rowCount: number, width: number): string[] {
  const padded = lines.map((line) => padLine(fitLine(line, width), width))
  while (padded.length < rowCount) padded.push(padLine('', width))
  return padded.slice(0, rowCount)
}

function scrollWindow<T>(items: readonly T[], selectedIndex: number, visibleRows: number): readonly T[] {
  return items.slice(
    windowStart(items.length, selectedIndex, visibleRows),
    windowStart(items.length, selectedIndex, visibleRows) + visibleRows
  )
}

function windowStart(itemCount: number, selectedIndex: number, visibleRows: number): number {
  if (itemCount <= visibleRows) return 0
  const half = Math.floor(visibleRows / 2)
  return clamp(selectedIndex - half, 0, Math.max(0, itemCount - visibleRows))
}
