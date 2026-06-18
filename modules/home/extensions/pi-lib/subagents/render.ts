// ABOUT: Renders SubagentRunState/SubagentRunResult into pi-tui Component trees.
// Visual taste is borrowed from nicobailon/pi-subagents; the data model and
// glue are ours. Two entrypoints: createSubagentMessageRenderer (slash flow,
// driven by runner.ts) and renderSubagentToolResult (model-invoked tool flow).

import type { Theme } from '@earendil-works/pi-coding-agent'
import { Box, type Component, Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'
import { resolveMarkdownTheme } from '@pi/lib/ui/markdown-overlay.ts'
import {
  formatDuration,
  formatTokenStat,
  formatTokens,
  formatToolCall,
  formatToolUseStat,
  runGlyph,
  SUBAGENT_ANIMATION_MS,
  singleLine,
  slotGlyph,
  statJoin,
  themeBold,
  truncate,
  truncLine
} from './render-helpers.ts'
import {
  combineSubagentUsage,
  type SubagentRunRequest,
  type SubagentRunResult,
  type SubagentRunState,
  type SubagentSlotResult,
  type SubagentToolSnapshot,
  type SubagentUsage
} from './types.ts'

export const SUBAGENT_RUN_MESSAGE_TYPE = 'subagents-run'

type Renderable = SubagentRunState | SubagentRunResult

interface RenderOptions {
  expanded: boolean
  width?: number
}

interface ToolRenderContextLike {
  invalidate: () => void
  isPartial?: boolean
  state: { subagentAnimationTimer?: ReturnType<typeof setInterval> }
}

// SECTION: ENTRYPOINTS //

/**
 * Factory matching pi's MessageRenderer signature. Looks up live runs by id
 * when only `runId` is on the message details.
 */
export function createSubagentMessageRenderer(liveRuns: ReadonlyMap<string, Renderable>) {
  return (message: { details?: unknown; content?: unknown }, options: { expanded: boolean }, theme: Theme): Component =>
    new LiveSubagentMessage(message.details, liveRuns, options.expanded, theme)
}

/**
 * CustomMessageComponent only rebuilds custom renderer output when expansion
 * changes or invalidate() fires. Keep this wrapper dynamic so liveRuns updates
 * and clock-based spinner frames render on ordinary requestRender() calls.
 */
class LiveSubagentMessage implements Component {
  constructor(
    private readonly details: unknown,
    private readonly liveRuns: ReadonlyMap<string, Renderable>,
    private readonly expanded: boolean,
    private readonly theme: Theme
  ) {}

  render(width: number): string[] {
    const run = extractRun(this.details, this.liveRuns)
    const innerWidth = Math.max(20, width - 2)
    const child = run
      ? renderSubagentRun(run, { expanded: this.expanded, width: innerWidth }, this.theme)
      : placeholder(this.theme, 'Subagent run details unavailable.')
    const box = new Box(1, 0, liveFeedBackground(this.theme))
    box.addChild(child)
    return box.render(width)
  }

  invalidate(): void {
    // render() is intentionally fresh each frame.
  }
}

function liveFeedBackground(theme: Theme): (text: string) => string {
  return (text: string) => {
    try {
      return theme.bg('customMessageBg', text)
    } catch {
      return text
    }
  }
}

/**
 * Tool-result entrypoint. Wires the spinner-driven invalidate loop while any
 * slot is running; pi calls this with a context whose invalidate() retriggers
 * just this tool row.
 */
export function renderSubagentToolResult(
  result: { details?: unknown },
  options: { expanded: boolean; isPartial?: boolean },
  theme: Theme,
  context?: ToolRenderContextLike
): Component {
  const run = extractRun(result.details)
  if (!run) return placeholder(theme, 'Subagent result has no run details.')
  if (context) syncSubagentAnimation(run, context, options.isPartial ?? context.isPartial)
  return renderSubagentRun(run, { expanded: options.expanded }, theme)
}

// SECTION: ANIMATION //

/** 80ms invalidate loop while partial + running; stops itself when all slots finish. */
export function syncSubagentAnimation(run: Renderable, context: ToolRenderContextLike, isPartial = true): void {
  const running = isPartial && run.slots.some((slot) => slot.status === 'running')
  if (!running) {
    stopAnimation(context)
    return
  }
  if (context.state.subagentAnimationTimer) return
  const timer = setInterval(() => {
    if (!run.slots.some((slot) => slot.status === 'running')) {
      stopAnimation(context)
      return
    }
    try {
      context.invalidate()
    } catch {
      stopAnimation(context)
    }
  }, SUBAGENT_ANIMATION_MS)
  ;(timer as { unref?: () => void }).unref?.()
  context.state.subagentAnimationTimer = timer
}

function stopAnimation(context: ToolRenderContextLike): void {
  const timer = context.state.subagentAnimationTimer
  if (!timer) return
  clearInterval(timer)
  context.state.subagentAnimationTimer = undefined
}

// SECTION: TOP-LEVEL DISPATCH //

export function renderSubagentRun(run: Renderable, options: RenderOptions, theme: Theme): Component {
  const width = Math.max(20, options.width ?? termWidth() - 4)
  if (run.mode === 'single' && run.slots.length === 1) {
    return options.expanded
      ? renderSingleExpanded(run, run.slots[0]!, theme, width)
      : renderSingleCompact(run, run.slots[0]!, theme, width)
  }
  return options.expanded ? renderMultiExpanded(run, theme, width) : renderMultiCompact(run, theme, width)
}

// SECTION: SINGLE-MODE LAYOUTS //

function renderSingleCompact(run: Renderable, slot: SubagentSlotResult, theme: Theme, width: number): Component {
  const c = new Container()
  const stats = slotStats(theme, slot)
  const header = `${slotGlyph(slot.status, theme)} ${theme.fg('toolTitle', themeBold(theme, slot.agent))}${stats ? ` ${theme.fg('dim', '·')} ${stats}` : ''}`
  c.addChild(new Text(truncLine(header, width), 0, 0))
  if (slot.status === 'running') {
    const activity = currentActivity(slot, width - 4)
    if (activity) c.addChild(new Text(truncLine(theme.fg('dim', `  ⎿  ${activity}`), width), 0, 0))
    c.addChild(new Text(truncLine(theme.fg('accent', '  Press Ctrl+O for live detail'), width), 0, 0))
  } else if (slot.error) {
    c.addChild(
      new Text(truncLine(theme.fg('error', `  ⎿  ${truncate(singleLine(slot.error), width - 6)}`), width), 0, 0)
    )
  }
  maybeAppendRunFooter(c, run, theme, width)
  return c
}

function renderSingleExpanded(run: Renderable, slot: SubagentSlotResult, theme: Theme, width: number): Component {
  const c = new Container()
  const isRunning = slot.status === 'running'
  const verb = isRunning
    ? theme.fg('warning', 'running')
    : slot.status === 'completed'
      ? theme.fg('success', 'ok')
      : slot.status === 'cancelled'
        ? theme.fg('warning', 'cancelled')
        : theme.fg('error', 'failed')
  const stats = slotStats(theme, slot)
  c.addChild(
    new Text(
      `${verb} ${theme.fg('toolTitle', themeBold(theme, slot.agent))}${stats ? ` ${theme.fg('dim', '·')} ${stats}` : ''}`,
      0,
      0
    )
  )
  c.addChild(new Spacer(1))
  c.addChild(new Text(theme.fg('dim', `Task: ${truncate(singleLine(slot.task), Math.max(20, width - 8))}`), 0, 0))
  c.addChild(new Spacer(1))

  if (isRunning) {
    const tools = recentTools(slot)
    const liveTool = tools.find((tool) => tool.status === 'running') ?? tools.at(-1)
    if (liveTool)
      c.addChild(new Text(theme.fg('warning', `> ${formatToolCall(liveTool.name, liveTool.args, true)}`), 0, 0))
    c.addChild(new Text(theme.fg('accent', 'Press Ctrl+O for live detail'), 0, 0))
    for (const tool of tools.slice(-3)) {
      c.addChild(new Text(theme.fg('dim', `  ${formatToolCall(tool.name, tool.args, false)}`), 0, 0))
    }
    for (const line of recentOutputLines(run, slot, 5)) {
      c.addChild(new Text(theme.fg('dim', `  ${line}`), 0, 0))
    }
    c.addChild(new Spacer(1))
  }

  const finalText = slot.output.finalOutput ?? slot.output.recentOutput
  if (finalText.trim()) {
    c.addChild(new Markdown(finalText, 0, 0, resolveMarkdownTheme()))
    c.addChild(new Spacer(1))
  }

  c.addChild(new Text(theme.fg('dim', formatUsageLine(slot.usage, slot.model)), 0, 0))
  maybeAppendRunFooter(c, run, theme, width)
  return c
}

// SECTION: MULTI-MODE LAYOUTS //

function renderMultiCompact(run: Renderable, theme: Theme, width: number): Component {
  const c = new Container()
  c.addChild(new Text(truncLine(buildRunHeader(run, theme), width), 0, 0))
  for (const slot of run.slots) {
    const label = slotLabel(run.request, slot)
    const stats = slotStats(theme, slot)
    const pending = slot.status === 'pending' ? ` ${theme.fg('dim', '· pending')}` : ''
    const head = `${slotGlyph(slot.status, theme)} ${label}: ${themeBold(theme, slot.agent)}${stats ? ` ${theme.fg('dim', '·')} ${stats}` : ''}${pending}`
    c.addChild(new Text(truncLine(`  ${head}`, width), 0, 0))
    if (slot.status === 'running') {
      const activity = currentActivity(slot, width - 8)
      if (activity) c.addChild(new Text(truncLine(theme.fg('dim', `    ⎿  ${activity}`), width), 0, 0))
    } else if (slot.error && slot.status !== 'skipped') {
      c.addChild(
        new Text(truncLine(theme.fg('error', `    ⎿  ${truncate(singleLine(slot.error), width - 8)}`), width), 0, 0)
      )
    }
  }
  if (run.slots.some((slot) => slot.status === 'running')) {
    c.addChild(new Text(theme.fg('accent', '  Press Ctrl+O for live detail'), 0, 0))
  }
  return c
}

function renderMultiExpanded(run: Renderable, theme: Theme, width: number): Component {
  const c = new Container()
  c.addChild(new Text(buildRunHeader(run, theme), 0, 0))
  c.addChild(new Spacer(1))
  for (const slot of run.slots) {
    c.addChild(renderSlotBlock(run, slot, theme, width))
    c.addChild(new Spacer(1))
  }
  if ('truncation' in run && run.truncation?.truncated) {
    c.addChild(new Text(theme.fg('warning', run.truncation.note ?? 'parent result truncated'), 0, 0))
  }
  return c
}

function renderSlotBlock(run: Renderable, slot: SubagentSlotResult, theme: Theme, width: number): Component {
  const c = new Container()
  const isRunning = slot.status === 'running'
  const label = slotLabel(run.request, slot)
  const stats = slotStats(theme, slot)
  const head = `${slotGlyph(slot.status, theme)} ${label}: ${themeBold(theme, slot.agent)}${slot.model ? theme.fg('dim', ` (${slot.model})`) : ''}${stats ? ` ${theme.fg('dim', '·')} ${stats}` : ''}`
  c.addChild(new Text(head, 0, 0))
  c.addChild(new Text(theme.fg('dim', `  task: ${truncate(singleLine(slot.task), Math.max(20, width - 12))}`), 0, 0))
  if (isRunning) {
    const tools = recentTools(slot)
    const liveTool = tools.find((tool) => tool.status === 'running') ?? tools.at(-1)
    if (liveTool)
      c.addChild(new Text(theme.fg('warning', `  > ${formatToolCall(liveTool.name, liveTool.args, true)}`), 0, 0))
    for (const tool of tools.slice(-3)) {
      c.addChild(new Text(theme.fg('dim', `    ${formatToolCall(tool.name, tool.args, false)}`), 0, 0))
    }
    for (const line of recentOutputLines(run, slot, 5)) {
      c.addChild(new Text(theme.fg('dim', `    ${line}`), 0, 0))
    }
    c.addChild(new Text(theme.fg('accent', '  Press Ctrl+O for live detail'), 0, 0))
  } else if (slot.error) {
    c.addChild(new Text(theme.fg('error', `  ⎿  ${truncate(singleLine(slot.error), width - 4)}`), 0, 0))
  }
  const finalText = slot.output.finalOutput ?? (slot.status === 'completed' ? slot.output.recentOutput : '')
  if (finalText.trim()) {
    c.addChild(new Spacer(1))
    c.addChild(new Markdown(finalText, 0, 0, resolveMarkdownTheme()))
  }
  return c
}

// SECTION: HEADER + STATS //

function buildRunHeader(run: Renderable, theme: Theme): string {
  const total = run.slots.length
  const done = run.slots.filter((slot) => slot.status === 'completed' || slot.status === 'skipped').length
  const running = run.slots.filter((slot) => slot.status === 'running').length
  const failed = run.slots.filter((slot) => slot.status === 'failed' || slot.status === 'cancelled').length
  const usage = combineSubagentUsage(run.slots.map((slot) => slot.usage))
  const elapsed = aggregateElapsed(run)

  const statusParts: (string | undefined)[] = []
  if (run.mode === 'chain') statusParts.push(stepHeader(run, running))
  if (running > 0) statusParts.push(running === 1 ? '1 agent running' : `${running} agents running`)
  statusParts.push(`${done}/${total} done`)
  if (failed > 0) statusParts.push(theme.fg('error', `${failed} failed`))
  statusParts.push(usage.turns > 0 ? formatToolUseStat(totalToolCount(run)) : undefined)
  statusParts.push(
    usage.inputTokens + usage.outputTokens > 0 ? formatTokenStat(usage.inputTokens + usage.outputTokens) : undefined
  )
  statusParts.push(elapsed > 0 ? formatDuration(elapsed) : undefined)

  return `${runGlyph(run.status, theme)} ${theme.fg('toolTitle', themeBold(theme, run.mode))} ${theme.fg('dim', '·')} ${statJoin(theme, statusParts)}`
}

function stepHeader(run: Renderable, running: number): string {
  const total = run.slots.length
  const finished = run.slots.filter((slot) => slot.status !== 'pending' && slot.status !== 'running').length
  const current = running > 0 ? Math.min(total, finished + 1) : finished
  return `step ${current}/${total}`
}

function slotLabel(request: SubagentRunRequest, slot: SubagentSlotResult): string {
  if (request.mode === 'chain') {
    const idx = request.slots.findIndex((plan) => plan.id === slot.id)
    return `Step ${(idx >= 0 ? idx : 0) + 1}/${request.slots.length}`
  }
  if (request.mode === 'parallel') {
    const idx = request.slots.findIndex((plan) => plan.id === slot.id)
    return `Agent ${(idx >= 0 ? idx : 0) + 1}/${request.slots.length}`
  }
  return slot.agent
}

function slotStats(theme: Theme, slot: SubagentSlotResult): string {
  const parts: (string | undefined)[] = []
  if (slot.toolCount > 0) parts.push(formatToolUseStat(slot.toolCount))
  const tokens = slot.usage.inputTokens + slot.usage.outputTokens
  if (tokens > 0) parts.push(formatTokenStat(tokens))
  const elapsedMs = slotElapsedMs(slot)
  if (elapsedMs > 0) parts.push(formatDuration(elapsedMs))
  return statJoin(theme, parts)
}

function slotElapsedMs(slot: SubagentSlotResult): number {
  if (slot.status === 'running') return Math.max(0, Date.now() - slot.duration.startedAt)
  return slot.duration.elapsedMs
}

// SECTION: ACTIVITY DERIVATION //

function currentActivity(slot: SubagentSlotResult, maxWidth: number): string {
  if (slot.currentTool) {
    const tool =
      slot.tools.find((entry) => entry.name === slot.currentTool && entry.status === 'running') ?? slot.tools.at(-1)
    if (tool) {
      const elapsed = tool.startedAt ? Math.max(0, Date.now() - tool.startedAt) : 0
      const dur = elapsed > 0 ? ` · ${formatDuration(elapsed)}` : ''
      return truncate(`${formatToolCall(tool.name, tool.args, false)}${dur}`, Math.max(20, maxWidth))
    }
    return slot.currentTool
  }
  if (slot.status === 'running') return 'thinking…'
  return ''
}

function recentTools(slot: SubagentSlotResult): SubagentToolSnapshot[] {
  return slot.tools.slice(-6)
}

function recentOutputLines(run: Renderable, slot: SubagentSlotResult, max: number): string[] {
  const fromEvents: string[] = []
  for (let i = run.events.length - 1; i >= 0 && fromEvents.length < max; i--) {
    const event = run.events[i]!
    if (event.slotId !== slot.id || event.type !== 'slot-output' || typeof event.text !== 'string') continue
    const lines = event.text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
    for (let j = lines.length - 1; j >= 0 && fromEvents.length < max; j--) fromEvents.push(lines[j]!)
  }
  if (fromEvents.length > 0) return fromEvents.reverse()
  return slot.output.recentOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-max)
}

function totalToolCount(run: Renderable): number {
  return run.slots.reduce((acc, slot) => acc + slot.toolCount, 0)
}

function aggregateElapsed(run: Renderable): number {
  if (run.mode === 'chain') return run.slots.reduce((acc, slot) => acc + slotElapsedMs(slot), 0)
  return run.slots.reduce((acc, slot) => Math.max(acc, slotElapsedMs(slot)), 0)
}

function formatUsageLine(usage: SubagentUsage, model?: string): string {
  const parts: string[] = []
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? '' : 's'}`)
  if (usage.inputTokens) parts.push(`in:${formatTokens(usage.inputTokens)}`)
  if (usage.outputTokens) parts.push(`out:${formatTokens(usage.outputTokens)}`)
  if (usage.cacheReadTokens) parts.push(`R${formatTokens(usage.cacheReadTokens)}`)
  if (usage.cacheWriteTokens) parts.push(`W${formatTokens(usage.cacheWriteTokens)}`)
  if (usage.costUsd) parts.push(`$${usage.costUsd.toFixed(4)}`)
  if (model) parts.push(model)
  return parts.join(' ')
}

function maybeAppendRunFooter(c: Container, run: Renderable, theme: Theme, width: number): void {
  if ('truncation' in run && run.truncation?.truncated) {
    c.addChild(new Text(truncLine(theme.fg('warning', run.truncation.note ?? 'output truncated'), width), 0, 0))
  }
}

// SECTION: HELPERS //

function extractRun(details: unknown, liveRuns?: ReadonlyMap<string, Renderable>): Renderable | undefined {
  if (!details || typeof details !== 'object') return undefined
  const data = details as {
    runId?: unknown
    run?: unknown
    result?: unknown
    state?: unknown
  }
  if (isRun(data.run)) return data.run
  if (isRun(data.result)) return data.result
  if (isRun(data.state)) return data.state
  if (typeof data.runId === 'string' && liveRuns) {
    const live = liveRuns.get(data.runId)
    if (isRun(live)) return live
  }
  return undefined
}

function isRun(value: unknown): value is Renderable {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { slots?: unknown }).slots)
}

function placeholder(theme: Theme, message: string): Component {
  return new Text(theme.fg('muted', message), 0, 0)
}

function termWidth(): number {
  return process.stdout.columns || 100
}
