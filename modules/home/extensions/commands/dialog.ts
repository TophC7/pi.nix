import type { Api, Model } from '@mariozechner/pi-ai'
import type { ExtensionCommandContext, Theme } from '@mariozechner/pi-coding-agent'
import { Input, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'
import {
  openDialog,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader,
  type DialogContent
} from '@pi/lib/ui'
import {
  CONFIG_PATH,
  MANAGED_COMMANDS,
  THINKING_LEVELS,
  getCommandsConfig,
  saveCommandConfig,
  type CommandModelConfig,
  type ManagedCommand,
  type ThinkingLevel
} from './config'

const COMMAND_LABELS: Record<ManagedCommand, string> = {
  commit: '/commit',
  pr: '/pr',
  compact: '/compact'
}

const COMMAND_DESCRIPTIONS: Record<ManagedCommand, string> = {
  commit: 'One-shot prompt that commits currently staged changes.',
  pr: 'One-shot prompt that creates pull request text from current branch changes.',
  compact: 'Builtin context compaction. Pi applies this config before compacting, then restores.'
}

const FOOTER_KEYS = [
  { key: '↑↓', label: 'setting' },
  { key: 'Enter', label: 'edit' },
  { key: 'd', label: 'default setting' },
  { key: 'D', label: 'default command' },
  { key: 'Esc', label: 'close' }
] as const

const MODEL_PICKER_FOOTER = [
  { key: 'type', label: 'filter' },
  { key: '↑↓', label: 'move' },
  { key: 'Enter', label: 'select' },
  { key: 'Esc', label: 'back' }
] as const

interface ConfigRow {
  readonly command: ManagedCommand
  readonly field: 'model' | 'thinking'
}

interface ModelChoice {
  readonly value: string
  readonly label: string
  readonly detail: string
}

type DialogMode =
  | { readonly kind: 'config' }
  | {
      readonly kind: 'model'
      readonly command: ManagedCommand
      readonly input: Input
      readonly selectedIndex: number
      readonly choices?: readonly ModelChoice[]
      readonly error?: string
    }

const CONFIG_ROWS: readonly ConfigRow[] = MANAGED_COMMANDS.flatMap((command) => [
  { command, field: 'model' as const },
  { command, field: 'thinking' as const }
])

export function openCommandsConfigDialog(ctx: ExtensionCommandContext): void {
  openDialog(ctx, ({ tui, theme, close }) => new CommandsConfigDialog(ctx, tui, theme, close), {
    width: '96%',
    maxHeight: '90%',
    minWidth: 72,
    padding: 0,
    borderStyle: 'square'
  })
}

class CommandsConfigDialog implements DialogContent {
  private config = getCommandsConfig()
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
    return this.renderConfig(safeWidth)
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.mode.kind === 'model') {
      this.handleModelInput(data, this.mode)
      return
    }
    this.handleConfigInput(data)
  }

  private renderConfig(width: number): string[] {
    const header = renderDialogHeader({ title: 'Command config', theme: this.theme, width })
    const footer = renderDialogFooter({ theme: this.theme, width, keys: FOOTER_KEYS, status: this.status })
    const bodyRows = rowBudget()
    const rows = scrollWindow(CONFIG_ROWS, this.selectedRowIndex, Math.max(8, bodyRows - 5)).map((row, index) => {
      const absoluteIndex = windowStart(CONFIG_ROWS.length, this.selectedRowIndex, Math.max(8, bodyRows - 5)) + index
      return this.configRowLine(row, absoluteIndex === this.selectedRowIndex, width)
    })
    const selected = CONFIG_ROWS[this.selectedRowIndex] ?? CONFIG_ROWS[0]!
    const details = this.detailLines(selected, width)
    return [
      header,
      renderDialogDivider({ theme: this.theme, width }),
      ...padRows(rows, Math.max(8, bodyRows - 5), width),
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
          return this.modelChoiceLine(choice, absoluteIndex === selectedIndex, mode.command, width)
        })
      : [this.theme.fg('muted', fitRaw('Loading models from configured providers…', width))]
    const status = mode.error ?? (mode.choices ? `${choices.length} models` : 'loading')
    return [
      renderDialogHeader({
        title: `${COMMAND_LABELS[mode.command]} model`,
        theme: this.theme,
        width,
        searchInput: mode.input
      }),
      renderDialogDivider({ theme: this.theme, width }),
      ...padRows(rows, bodyRows, width),
      renderDialogDivider({ theme: this.theme, width }),
      renderDialogFooter({ theme: this.theme, width, keys: MODEL_PICKER_FOOTER, status })
    ]
  }

  private handleConfigInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.close()
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
    if (data === 'D') {
      this.defaultSelectedCommand()
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
      if (choice) this.saveModelChoice(mode.command, choice.value)
      return
    }
    mode.input.handleInput(data)
    this.mode = { ...mode, selectedIndex: 0 }
    this.tui.requestRender()
  }

  private moveRow(delta: number): void {
    this.selectedRowIndex = clamp(this.selectedRowIndex + delta, 0, CONFIG_ROWS.length - 1)
    this.status = undefined
    this.tui.requestRender()
  }

  private async editSelectedRow(): Promise<void> {
    const row = CONFIG_ROWS[this.selectedRowIndex]
    if (!row) return
    if (row.field === 'thinking') {
      this.cycleThinking(row.command)
      this.tui.requestRender()
      return
    }
    await this.openModelPicker(row.command)
  }

  private async openModelPicker(command: ManagedCommand): Promise<void> {
    const input = new Input()
    input.focused = true
    this.mode = { kind: 'model', command, input, selectedIndex: 0 }
    this.status = undefined
    this.tui.requestRender()
    try {
      const choices = await this.loadModelChoices()
      this.mode = {
        kind: 'model',
        command,
        input,
        selectedIndex: this.initialModelIndex(command, choices),
        choices
      }
    } catch (error) {
      this.modelChoicesPromise = undefined
      this.mode = {
        kind: 'model',
        command,
        input,
        selectedIndex: 0,
        choices: [{ value: 'default', label: 'default', detail: 'use current session model' }],
        error: error instanceof Error ? error.message : String(error)
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

  private initialModelIndex(command: ManagedCommand, choices: readonly ModelChoice[]): number {
    const current = this.config[command].model ?? 'default'
    if (current === 'default') return 0
    return Math.max(0, choices.findIndex((choice) => choice.value === current))
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

  private saveModelChoice(command: ManagedCommand, selected: string): void {
    this.save(command, { ...this.config[command], model: selected === 'default' ? undefined : selected })
    this.status = `${COMMAND_LABELS[command]} model → ${selected}`
    this.mode = { kind: 'config' }
    this.tui.requestRender()
  }

  private cycleThinking(command: ManagedCommand): void {
    const current = this.config[command].thinking ?? 'default'
    const values = ['default', ...THINKING_LEVELS] as const
    const index = Math.max(0, values.indexOf(current))
    const next = values[(index + 1) % values.length]
    this.save(command, { ...this.config[command], thinking: next === 'default' ? undefined : next })
    this.status = `${COMMAND_LABELS[command]} thinking → ${next}`
  }

  private defaultSelectedField(): void {
    const row = CONFIG_ROWS[this.selectedRowIndex]
    if (!row) return
    const current = this.config[row.command]
    if (row.field === 'model') this.save(row.command, { ...current, model: undefined })
    else this.save(row.command, { ...current, thinking: undefined })
    this.status = `${COMMAND_LABELS[row.command]} ${row.field} → default`
    this.tui.requestRender()
  }

  private defaultSelectedCommand(): void {
    const row = CONFIG_ROWS[this.selectedRowIndex]
    if (!row) return
    this.save(row.command, {})
    this.status = `${COMMAND_LABELS[row.command]} → defaults`
    this.tui.requestRender()
  }

  private save(command: ManagedCommand, config: CommandModelConfig): void {
    this.config = saveCommandConfig(command, config)
  }

  private configRowLine(row: ConfigRow, selected: boolean, width: number): string {
    const value = row.field === 'model' ? this.config[row.command].model ?? 'default' : this.config[row.command].thinking ?? 'default'
    const cursor = selected ? this.theme.fg('accent', this.theme.bold('>')) : ' '
    const commandText = COMMAND_LABELS[row.command].padEnd(9)
    const command = selected ? this.theme.bold(commandText) : commandText
    const field = selected ? this.theme.fg('accent', row.field.padEnd(8)) : row.field.padEnd(8)
    const renderedValue = selected ? this.theme.fg('accent', modelLabel(value)) : this.theme.fg('muted', modelLabel(value))
    return fit(`${cursor} ${command} ${field} ${renderedValue}`, width, this.theme)
  }

  private detailLines(row: ConfigRow, width: number): string[] {
    const action = row.field === 'model' ? 'Enter opens searchable model list.' : 'Enter cycles thinking level.'
    return [
      this.theme.fg('accent', fitRaw(` [ ${COMMAND_LABELS[row.command]} ${row.field} ]`, width)),
      this.theme.fg('muted', fitRaw(` ${COMMAND_DESCRIPTIONS[row.command]}`, width)),
      this.theme.fg('dim', fitRaw(` ${action} d resets this setting. D resets ${COMMAND_LABELS[row.command]}.`, width)),
      this.theme.fg('dim', fitRaw(` ${CONFIG_PATH}`, width))
    ]
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

  private modelChoiceLine(choice: ModelChoice, selected: boolean, command: ManagedCommand, width: number): string {
    const current = choice.value === (this.config[command].model ?? 'default')
    const cursor = selected ? this.theme.fg('accent', this.theme.bold('>')) : ' '
    const flag = current ? this.theme.fg('success', '*') : ' '
    const label = selected ? this.theme.bold(choice.label) : choice.label
    const detail = this.theme.fg('muted', choice.detail)
    return fit(`${cursor}${flag} ${label}  ${detail}`, width, this.theme)
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

function modelLabel(value: string): string {
  if (value === 'default') return value
  const slash = value.indexOf('/')
  return slash >= 0 ? value.slice(slash + 1) : value
}

function rowBudget(): number {
  const rows = typeof process.stdout.rows === 'number' && Number.isFinite(process.stdout.rows) ? process.stdout.rows : 36
  return clamp(Math.floor(rows * 0.55), 12, 26)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fit(text: string, width: number, theme: Theme): string {
  const truncated = truncateToWidth(text, Math.max(0, width), '…', true)
  const remaining = Math.max(0, width - visibleWidth(truncated))
  return `${truncated}${theme.fg('muted', ' '.repeat(remaining))}`
}

function fitRaw(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width), '…', true)
  return `${truncated}${' '.repeat(Math.max(0, width - visibleWidth(truncated)))}`
}

function padRows(lines: readonly string[], rowCount: number, width: number): string[] {
  const padded = [...lines]
  while (padded.length < rowCount) padded.push(' '.repeat(width))
  return padded.slice(0, rowCount)
}

function scrollWindow<T>(items: readonly T[], selectedIndex: number, visibleRows: number): readonly T[] {
  return items.slice(windowStart(items.length, selectedIndex, visibleRows), windowStart(items.length, selectedIndex, visibleRows) + visibleRows)
}

function windowStart(itemCount: number, selectedIndex: number, visibleRows: number): number {
  if (itemCount <= visibleRows) return 0
  const half = Math.floor(visibleRows / 2)
  return clamp(selectedIndex - half, 0, Math.max(0, itemCount - visibleRows))
}
