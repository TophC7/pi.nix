import { CustomEditor, type KeybindingsManager } from '@mariozechner/pi-coding-agent'
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'
import {
  fitLine,
  padLine,
  stripControls,
  type UiRenderCapabilities,
  type UiRenderClock,
  type UiSnapshot,
  type UiWidgetEntry,
  type UiWidgetHost
} from '@pi/lib/ui'
import { formatWorkspaceLabel } from './format.ts'
import { paint, paintIf, rainbowRole } from './palette.ts'
import { renderSlabLine } from './renderer.ts'
import { renderSegment, SLAB_SEGMENT_BY_ID } from './segments.ts'
import type { SlabConfig, SlabRuntimeState, SlabSegmentRenderContext, SlabSegmentRenderResult } from './types.ts'

const CONTENT_PADDING_X = 1
const AUTOCOMPLETE_INDENT = CONTENT_PADDING_X
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

const HORIZONTAL = '─'
const ASCII_HORIZONTAL = '-'

export interface SlabEditorState {
  config: SlabConfig
  surface: SlabRuntimeState
  snapshot: UiSnapshot
  clock: UiRenderClock
}

export interface SlabEditorWrapOptions {
  state: SlabEditorState
  width: number
  capabilities: UiRenderCapabilities
  focused: boolean
  slashCommand?: string
  shimmerPhase?: number
  paintThinkingBorder?: (thinking: string | undefined | null, text: string) => string
}

const SLASH_COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)/

export interface SlashCommandMatch {
  command: string
  name: string
}

export function detectSlashCommand(text: string, recognized?: ReadonlySet<string>): SlashCommandMatch | undefined {
  const match = text.match(SLASH_COMMAND_PATTERN)
  if (!match) return undefined
  const name = match[1]!
  if (recognized && !recognized.has(name)) return undefined
  return { command: match[0], name }
}

function wrapVisibleRange(
  line: string,
  start: number,
  end: number,
  wrap: (ch: string, index: number) => string
): string {
  let out = ''
  let visibleIndex = 0
  let rangeIndex = 0
  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)
    const ansi = rest.match(/^\x1b\[[0-9;]*m/)
    if (ansi) {
      out += ansi[0]
      i += ansi[0].length
      continue
    }
    const ch = line[i]!
    if (visibleIndex >= start && visibleIndex < end) {
      out += wrap(ch, rangeIndex)
      rangeIndex++
    } else {
      out += ch
    }
    visibleIndex++
    i++
  }
  return out
}

function colorizeSlashCommand(line: string, command: string, caps: UiRenderCapabilities, phase: number): string {
  if (!caps.color || !command) return line
  const plain = stripControls(line)
  const start = plain.indexOf(command)
  if (start < 0) return line
  return wrapVisibleRange(line, start, start + command.length, (ch, idx) => paint(rainbowRole(idx + phase), ch))
}

function clean(text: string, caps: UiRenderCapabilities): string {
  return caps.color ? text : text.replace(ANSI_PATTERN, '')
}

function fit(text: string, width: number, caps: UiRenderCapabilities): string {
  const cleaned = clean(text, caps)
  return caps.unicode ? fitLine(cleaned, width) : truncateToWidth(cleaned, Math.max(0, width), '...')
}

function normalizeContent(line: string, width: number, caps: UiRenderCapabilities): string {
  return padLine(fit(line, width, caps), width)
}

function indentAutocompleteLine(line: string, width: number, caps: UiRenderCapabilities): string {
  const indent = ' '.repeat(Math.min(AUTOCOMPLETE_INDENT, Math.max(0, width - 1)))
  return normalizeContent(`${indent}${line}`, width, caps)
}

function isHorizontalBorder(line: string): boolean {
  const plain = stripControls(line).trim()
  if (!plain) return false
  // Pi's stock editor border is pure `─`; tolerate corner glyphs so the
  // pane preview's fake rawLines still register, and accept scroll arrows.
  return (
    plain.includes(HORIZONTAL) &&
    [...plain].every(
      (char) =>
        char === HORIZONTAL ||
        char === ' ' ||
        char === '↑' ||
        char === '↓' ||
        '╭╮╰╯'.includes(char) ||
        /[0-9a-z]/i.test(char)
    )
  )
}

function scrollIndicator(line: string, caps: UiRenderCapabilities): string | undefined {
  const match = stripControls(line).match(/(?:↑|↓) \d+ more/)
  if (!match) return undefined
  const ruler = (caps.unicode ? HORIZONTAL : ASCII_HORIZONTAL).repeat(3)
  return `${ruler} ${match[0]} `
}

function ruleChar(caps: UiRenderCapabilities): string {
  return caps.unicode ? HORIZONTAL : ASCII_HORIZONTAL
}

function paintRule(
  text: string,
  state: SlabEditorState,
  caps: UiRenderCapabilities,
  focused: boolean,
  paintThinkingBorder: ((thinking: string | undefined | null, text: string) => string) | undefined
): string {
  if (!caps.color) return text
  if (!focused) return paint('dim', text)
  return paintThinkingBorder?.(state.surface.model.thinking, text) ?? paint('red', text)
}

function buildSegmentRenderContext(
  state: SlabEditorState,
  width: number,
  caps: UiRenderCapabilities
): SlabSegmentRenderContext {
  return {
    state: state.surface,
    config: state.config,
    widthMode: 'full',
    showProvider: false,
    render: { width, ...caps, ...state.clock }
  }
}

function styleInfoSection(text: string, caps: UiRenderCapabilities, order: number): string {
  if (!caps.color) return text
  return paint(rainbowRole(order), text)
}

function renderGitInfoSegment(
  state: SlabEditorState,
  width: number,
  caps: UiRenderCapabilities
): SlabSegmentRenderResult | undefined {
  const gitSegmentConfig = state.config.segments.find((entry) => entry.id === 'git')
  if (!gitSegmentConfig?.enabled) return undefined
  const ctx = buildSegmentRenderContext(state, width, caps)
  const def = SLAB_SEGMENT_BY_ID.get('git')
  return def ? renderSegment(ctx, def) : undefined
}

interface ComposedFragment {
  text: string
  width: number
}

function composePathAndGit(
  state: SlabEditorState,
  width: number,
  caps: UiRenderCapabilities,
  focused: boolean,
  gitResult: SlabSegmentRenderResult | undefined
): ComposedFragment {
  const surface = state.surface
  const maxLabelWidth = Math.max(8, Math.floor(width * 0.55))
  const path = formatWorkspaceLabel(
    surface.workspace.path,
    surface.workspace.name,
    state.config.display.workspaceLabel,
    maxLabelWidth,
    width
  )
  const pathStyled = focused ? styleInfoSection(path, caps, 0) : paintIf(caps.color, 'dim', path)

  const parts: string[] = [pathStyled]
  if (gitResult) {
    const styled = focused ? styleInfoSection(gitResult.text, caps, 1) : paintIf(caps.color, 'dim', gitResult.text)
    parts.push(styled)
  }

  const separator = paintIf(caps.color, 'dim', ' · ')
  const text = parts.join(separator)
  return { text, width: visibleWidth(text) }
}

function composeRightSegments(
  state: SlabEditorState,
  width: number,
  caps: UiRenderCapabilities,
  focused: boolean,
  colorOffset: number
): ComposedFragment {
  const raw = renderSlabLine(state.surface, state.config, width, caps, state.clock, {
    exclude: ['git'],
    colorOffset
  })
  if (!raw) return { text: '', width: 0 }
  const text = focused ? raw : paintIf(caps.color, 'dim', stripControls(raw))
  return { text, width: visibleWidth(text) }
}

// The info line sits *above* the top rule. Edge padding matches the content
// row (1 char) so the workspace label aligns with what the user types. The
// middle is plain spaces, which lets the two information halves drift to
// their respective edges without an arbitrary rule glyph between them.
function makeInfoLine(state: SlabEditorState, width: number, caps: UiRenderCapabilities, focused: boolean): string {
  const innerWidth = Math.max(0, width - CONTENT_PADDING_X * 2)
  const gap = 2 // minimum visual gap between left and right halves
  const rightBudget = Math.max(0, innerWidth - 1 - gap)
  const gitResult = renderGitInfoSegment(state, innerWidth, caps)
  const rightColorOffset = 1 + (gitResult ? 1 : 0)
  const right = composeRightSegments(state, rightBudget, caps, focused, rightColorOffset)
  const leftBudget = Math.max(1, innerWidth - (right.width > 0 ? right.width + gap : 0))
  const left = composePathAndGit(state, leftBudget, caps, focused, gitResult)
  const pad = ' '.repeat(CONTENT_PADDING_X)

  if (right.width === 0) {
    const trailing = ' '.repeat(Math.max(0, innerWidth - left.width))
    return `${pad}${left.text}${trailing}${pad}`
  }
  const middle = ' '.repeat(Math.max(gap, innerWidth - left.width - right.width))
  return `${pad}${left.text}${middle}${right.text}${pad}`
}

function makeRule(
  rawLine: string,
  state: SlabEditorState,
  width: number,
  caps: UiRenderCapabilities,
  focused: boolean,
  paintThinkingBorder: ((thinking: string | undefined | null, text: string) => string) | undefined
): string {
  const rule = ruleChar(caps)
  const scrollMark = scrollIndicator(rawLine, caps)
  if (scrollMark) {
    const fillerWidth = Math.max(0, width - visibleWidth(scrollMark))
    return paintRule(`${scrollMark}${rule.repeat(fillerWidth)}`, state, caps, focused, paintThinkingBorder)
  }
  return paintRule(rule.repeat(Math.max(0, width)), state, caps, focused, paintThinkingBorder)
}

function wrapContentLine(line: string, width: number, caps: UiRenderCapabilities): string {
  const padding = ' '.repeat(CONTENT_PADDING_X)
  const innerWidth = Math.max(1, width - CONTENT_PADDING_X * 2)
  const content = normalizeContent(line, innerWidth, caps)
  return `${padding}${content}${padding}`
}

export function wrapSlabEditorLines(rawLines: string[], options: SlabEditorWrapOptions): string[] {
  const { state, capabilities: caps, focused } = options
  if (!state.config.enabled) return rawLines.map((line) => fit(line, options.width, caps))
  const safeWidth = Math.max(4, options.width)
  if (rawLines.length < 2) return rawLines.map((line) => fit(line, safeWidth, caps))

  let bottomIndex = -1
  for (let index = 1; index < rawLines.length; index++) {
    if (isHorizontalBorder(rawLines[index] ?? '')) bottomIndex = index
  }
  if (bottomIndex < 1) return rawLines.map((line) => fit(line, safeWidth, caps))

  const body = rawLines.slice(1, bottomIndex)
  const autocomplete = rawLines.slice(bottomIndex + 1)
  const contentLines = body.length > 0 ? [...body] : ['']
  const slashCommand = options.slashCommand
  const phase = options.shimmerPhase ?? 0
  const styledContent = contentLines.map((line, index) => {
    const tinted = index === 0 && slashCommand ? colorizeSlashCommand(line, slashCommand, caps, phase) : line
    return fit(wrapContentLine(tinted, safeWidth, caps), safeWidth, caps)
  })

  return [
    fit(makeInfoLine(state, safeWidth, caps, focused), safeWidth, caps),
    fit(makeRule(rawLines[0] ?? '', state, safeWidth, caps, focused, options.paintThinkingBorder), safeWidth, caps),
    ...styledContent,
    fit(
      makeRule(rawLines[bottomIndex] ?? '', state, safeWidth, caps, focused, options.paintThinkingBorder),
      safeWidth,
      caps
    ),
    ...autocomplete.map((line) => indentAutocompleteLine(line, safeWidth, caps))
  ]
}

function renderWidgetLines(
  host: UiWidgetHost,
  widgets: readonly UiWidgetEntry[],
  placement: UiWidgetEntry['placement'],
  width: number,
  caps: UiRenderCapabilities,
  clock: UiRenderClock
): string[] {
  return host
    .renderPlacement(widgets, placement, {
      width,
      capabilities: caps,
      ...clock
    })
    .map((line) => fit(line, width, caps))
}

function capabilities(): UiRenderCapabilities {
  const lang = process.env.LC_ALL || process.env.LANG || ''
  return {
    color: process.env.NO_COLOR === undefined,
    unicode: process.env.PI_SLAB_ASCII !== '1' && lang !== 'C'
  }
}

export interface SlabEditorHooks {
  recognizedCommands(): ReadonlySet<string>
  paintThinkingBorder?(thinking: string | undefined | null, text: string): string
  onTextChange?(text: string, match: SlashCommandMatch | undefined): void
}

export class SlabEditor extends CustomEditor {
  private currentSlashMatch: SlashCommandMatch | undefined

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly getState: () => SlabEditorState,
    private readonly widgetHost: UiWidgetHost,
    private readonly hooks: SlabEditorHooks
  ) {
    super(tui, theme, keybindings)
  }

  handleInput(data: string): void {
    if (this.widgetHost.handleInput(data)) return
    super.handleInput(data)
    const text = this.getText()
    this.currentSlashMatch = detectSlashCommand(text, this.hooks.recognizedCommands())
    this.hooks.onTextChange?.(text, this.currentSlashMatch)
  }

  render(width: number): string[] {
    const caps = capabilities()
    const state = this.getState()
    const safeWidth = Math.max(1, width)
    const renderWidth = Math.max(1, safeWidth - CONTENT_PADDING_X * 2)
    const rawEditor = super.render(renderWidth)
    const match = this.currentSlashMatch
    const editorSurface = wrapSlabEditorLines(rawEditor, {
      state,
      width: safeWidth,
      capabilities: caps,
      focused: this.focused,
      slashCommand: match?.command,
      shimmerPhase: state.clock.tick,
      paintThinkingBorder: this.hooks.paintThinkingBorder
    })
    const above = renderWidgetLines(
      this.widgetHost,
      state.snapshot.widgets,
      'aboveEditor',
      safeWidth,
      caps,
      state.clock
    )
    const below = renderWidgetLines(
      this.widgetHost,
      state.snapshot.widgets,
      'belowEditor',
      safeWidth,
      caps,
      state.clock
    )
    return [...above, ...editorSurface, ...below]
  }
}
