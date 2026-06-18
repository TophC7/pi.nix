// ABOUT: Slab's multi-category settings pane. The single-category settings
// primitive in @pi/lib/ui (showSettingsPane / SettingsList) doesn't fit this
// pane's category-grid + per-row mutate model. §T023 retained the current
// Component structure; promoting a multi-category settings primitive into
// @pi/lib/ui is tracked as future work after this spec lands.

import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey } from '@earendil-works/pi-tui'
import {
  type DialogContent,
  fitLine as fitLineShared,
  padLine,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader
} from '@pi/lib/ui'
import { cloneSlabConfig, defaultSlabConfig, moveSlabSegment, toggleSlabSegment } from './config.ts'
import { type SlabEditorState, wrapSlabEditorLines } from './editor.ts'
import { renderSlabFooterLines } from './footer.ts'
import { parseGitStatus } from './git.ts'
import type { SlabConfig, SlabSegmentId } from './types.ts'

type CategoryId = 'surface' | 'segments' | 'model' | 'metrics' | 'git'

type SettingRow = {
  label: string
  value: string
  hint: string
  mutate?: () => void
  segmentId?: SlabSegmentId
}

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'surface', label: 'Surface' },
  { id: 'segments', label: 'Segments' },
  { id: 'model', label: 'Model' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'git', label: 'Git' }
]

function nextIn<T extends string>(current: T, values: readonly T[]): T {
  const index = values.indexOf(current)
  return values[(index + 1) % values.length] ?? values[0]!
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off'
}

function segmentLabel(id: SlabSegmentId): string {
  return id[0]!.toUpperCase() + id.slice(1)
}

function row(label: string, value: string, hint: string, mutate?: () => void, segmentId?: SlabSegmentId): SettingRow {
  return { label, value, hint, mutate, segmentId }
}

export function slabPaneRows(
  config: SlabConfig,
  category: CategoryId,
  replace: (config: SlabConfig) => void
): SettingRow[] {
  switch (category) {
    case 'surface':
      return [
        row('Enabled', onOff(config.enabled), 'Turn slab on/off. Off restores stock Pi input.', () => {
          const next = cloneSlabConfig(config)
          next.enabled = !next.enabled
          replace(next)
        }),
        row(
          'Workspace',
          config.display.workspaceLabel,
          'How the left label is shortened: repo name, smart path, or full path.',
          () => {
            const next = cloneSlabConfig(config)
            next.display.workspaceLabel = nextIn(next.display.workspaceLabel, ['name', 'smart', 'path'] as const)
            replace(next)
          }
        ),
        row(
          'Provider',
          config.display.showProvider,
          'Show provider only when multiple providers exist, always, or never.',
          () => {
            const next = cloneSlabConfig(config)
            next.display.showProvider = nextIn(next.display.showProvider, ['auto', 'always', 'never'] as const)
            replace(next)
          }
        ),
        row(
          'Fit narrow terminals',
          onOff(config.display.adaptive),
          'At small widths, drop lower-priority right-side segments first.',
          () => {
            const next = cloneSlabConfig(config)
            next.display.adaptive = !next.display.adaptive
            replace(next)
          }
        )
      ]
    case 'segments':
      return config.segments.map((segment, index) =>
        row(
          `${index + 1}. ${segmentLabel(segment.id)}`,
          onOff(segment.enabled),
          'Enter toggles visibility. U/D moves this segment; color follows order.',
          () => replace(toggleSlabSegment(config, segment.id)),
          segment.id
        )
      )
    case 'model':
      return [
        row(
          'Thinking label',
          config.model.showThinking,
          'Show thinking level next to model: auto hides off/minimal noise.',
          () => {
            const next = cloneSlabConfig(config)
            next.model.showThinking = nextIn(next.model.showThinking, ['auto', 'always', 'never'] as const)
            replace(next)
          }
        )
      ]
    case 'metrics':
      return [
        row('Context', config.context.display, 'Show context as percent, tokens, or both.', () => {
          const next = cloneSlabConfig(config)
          next.context.display = nextIn(next.context.display, ['percent+tokens', 'percent', 'tokens'] as const)
          replace(next)
        }),
        row(
          'Cost',
          config.cost.hideZero ? 'hide zero' : 'always',
          'Hide cost until it is non-zero, or always reserve the segment.',
          () => {
            const next = cloneSlabConfig(config)
            next.cost.hideZero = !next.cost.hideZero
            replace(next)
          }
        ),
        row('Tokens', config.tokens.display, 'Show input/output arrows or one total token count.', () => {
          const next = cloneSlabConfig(config)
          next.tokens.display = nextIn(next.tokens.display, ['input-output', 'total'] as const)
          replace(next)
        })
      ]
    case 'git':
      return [
        row(
          'Dirty mark',
          onOff(config.git.showDirty),
          'Show ● when the working tree has changes; conflicts always show ⚠.',
          () => {
            const next = cloneSlabConfig(config)
            next.git.showDirty = !next.git.showDirty
            replace(next)
          }
        ),
        row('Ahead/behind', onOff(config.git.showAheadBehind), 'Show ↑/↓ counts against upstream.', () => {
          const next = cloneSlabConfig(config)
          next.git.showAheadBehind = !next.git.showAheadBehind
          replace(next)
        })
      ]
  }
}

function sampleState(config: SlabConfig): SlabEditorState {
  return {
    config,
    clock: { now: 1_000, tick: 3 },
    snapshot: { statuses: [], widgets: [], version: 1 },
    surface: {
      workspace: { name: 'pi.nix', path: '/repo/Nix/pi.nix' },
      git: parseGitStatus(
        `# branch.oid abcdef1234567890
# branch.head main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 a b file.ts
`,
        1_000
      ),
      providers: { availableCount: 2 },
      model: {
        id: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        displayName: 'Sonnet 4',
        thinking: 'high'
      },
      context: { tokens: 46_800, window: 200_000, percent: 23.4 },
      usage: {
        input: 12_400,
        output: 3_100,
        cacheRead: 800,
        cacheWrite: 0,
        cost: 0.042
      },
      statuses: [
        {
          id: 'preview-status',
          owner: 'slab',
          label: 'agent',
          text: 'ready',
          ordering: { priority: 'normal', order: 0 },
          lifecycle: { createdAt: 1_000, updatedAt: 1_000 }
        }
      ],
      version: 1
    }
  }
}

export function renderSlabConfigPreview(config: SlabConfig, width: number): string[] {
  const footer = renderSlabFooterLines(
    new Map([['mcp', 'MCP: 3/4 servers']]),
    ['Harbordrift [◉_◉]'],
    width,
    { color: true, unicode: true }
  )
  if (!config.enabled)
    return [
      'stock Pi input (slab disabled)',
      ...footer
    ]
  return [
    ...wrapSlabEditorLines(['╭────╮', 'Ask Pi to refactor this module', '╰────╯', 'autocomplete preview'], {
      state: sampleState(config),
      width,
      capabilities: { color: true, unicode: true },
      focused: true
    }),
    ...footer
  ]
}

function padTo(text: string, width: number): string {
  const safeWidth = Math.max(0, width)
  return padLine(fitLineShared(text, safeWidth), safeWidth)
}

function fitLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width)
  return padLine(fitLineShared(text, safeWidth), safeWidth)
}

const FOOTER_KEYS = [
  { key: '←/→', label: 'category' },
  { key: '↑/↓', label: 'row' },
  { key: 'Enter', label: 'apply' },
  { key: 'U/D', label: 'reorder' },
  { key: 'R', label: 'reset' },
  { key: 'Esc', label: 'close' }
] as const

export class SlabConfigPane implements DialogContent {
  private draft: SlabConfig
  private categoryIndex = 0
  private rowIndex = 0
  private status = 'live'

  constructor(
    initial: SlabConfig,
    private readonly theme: Theme,
    private readonly apply: (config: SlabConfig) => void,
    private readonly close: () => void
  ) {
    this.draft = cloneSlabConfig(initial)
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.close()
      return
    }
    if (data === 'r' || data === 'R') {
      this.replace(defaultSlabConfig(), 'reset to defaults')
      return
    }
    if (matchesKey(data, 'left')) this.moveCategory(-1)
    else if (matchesKey(data, 'right')) this.moveCategory(1)
    else if (matchesKey(data, 'up')) this.moveRow(-1)
    else if (matchesKey(data, 'down')) this.moveRow(1)
    else if (data === 'u' || data === 'U') this.moveSelectedSegment(-1)
    else if (data === 'd' || data === 'D') this.moveSelectedSegment(1)
    else if (matchesKey(data, 'enter') || data === ' ') this.mutateSelected()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(40, width)
    const rows = this.rows()
    const category = CATEGORIES[this.categoryIndex]!
    const statusText = `auto-applied${this.status ? ` · ${this.status}` : ''}`

    const header = renderDialogHeader({
      title: `Slab config  ·  ${statusText}`,
      theme: this.theme,
      width: safeWidth
    })
    const footer = renderDialogFooter({
      theme: this.theme,
      width: safeWidth,
      keys: FOOTER_KEYS
    })

    const lines: string[] = [header, renderDialogDivider({ theme: this.theme, width: safeWidth })]
    lines.push(...this.renderPreviewSection(safeWidth))
    lines.push(renderDialogDivider({ theme: this.theme, width: safeWidth }))
    lines.push(...this.renderCategoryTabs(safeWidth))
    lines.push(renderDialogDivider({ theme: this.theme, width: safeWidth }))
    lines.push(...this.renderSettingRows(rows, category.label, safeWidth))
    lines.push(renderDialogDivider({ theme: this.theme, width: safeWidth }))
    lines.push(footer)
    return lines
  }

  private renderCategoryTabs(width: number): string[] {
    const parts = CATEGORIES.map((item, index) =>
      index === this.categoryIndex
        ? this.theme.fg('accent', this.theme.bold(` ${item.label} `))
        : this.theme.fg('dim', ` ${item.label} `)
    )
    const joined = parts.join(this.theme.fg('dim', '│'))
    return [fitLine(`  ${joined}`, width)]
  }

  private renderSettingRows(rows: readonly SettingRow[], categoryLabel: string, width: number): string[] {
    const lines: string[] = [
      fitLine(`  ${this.theme.fg('muted', this.theme.bold(categoryLabel.toUpperCase()))}`, width)
    ]
    if (rows.length === 0) {
      return [...lines, fitLine(`  ${this.theme.fg('dim', 'No settings.')}`, width)]
    }
    const labelWidth = Math.max(16, Math.min(28, Math.floor(width * 0.32)))
    const valueWidth = Math.max(10, Math.min(24, Math.floor(width * 0.24)))
    rows.forEach((row, index) => {
      const selected = index === this.rowIndex
      const cursor = selected ? this.theme.fg('accent', this.theme.bold('›')) : ' '
      const label = padTo(row.label, labelWidth)
      const value = padTo(row.value, valueWidth)
      const styledLabel = selected ? this.theme.bold(label) : label
      const styledValue = selected ? this.theme.fg('accent', value) : this.theme.fg('muted', value)
      lines.push(fitLine(` ${cursor} ${styledLabel}  ${styledValue}`, width))
      if (selected) lines.push(fitLine(`   ${this.theme.fg('dim', row.hint)}`, width))
    })
    return lines
  }

  private renderPreviewSection(width: number): string[] {
    const previewWidth = Math.max(32, width - 4)
    return [
      fitLine(`  ${this.theme.fg('muted', this.theme.bold('PREVIEW'))}`, width),
      ...renderSlabConfigPreview(this.draft, previewWidth).map((line) => fitLine(`  ${line}`, width))
    ]
  }

  private rows(): SettingRow[] {
    return slabPaneRows(this.draft, CATEGORIES[this.categoryIndex]!.id, (next) => this.replace(next, 'changed'))
  }

  private replace(next: SlabConfig, status: string): void {
    this.draft = cloneSlabConfig(next)
    this.status = status
    this.apply(cloneSlabConfig(this.draft))
  }

  private moveCategory(direction: -1 | 1): void {
    this.categoryIndex = (this.categoryIndex + direction + CATEGORIES.length) % CATEGORIES.length
    this.rowIndex = 0
  }

  private moveRow(direction: -1 | 1): void {
    const rows = this.rows()
    if (rows.length === 0) return
    this.rowIndex = (this.rowIndex + direction + rows.length) % rows.length
  }

  private mutateSelected(): void {
    const item = this.rows()[this.rowIndex]
    item?.mutate?.()
  }

  private moveSelectedSegment(direction: -1 | 1): void {
    const item = this.rows()[this.rowIndex]
    if (!item?.segmentId) return
    this.replace(moveSlabSegment(this.draft, item.segmentId, direction), 'segment moved')
  }
}
