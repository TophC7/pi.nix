import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from '@earendil-works/pi-coding-agent'
import { type Component, truncateToWidth } from '@earendil-works/pi-tui'
import {
  createUiRenderDriver,
  getUiStatusStore,
  openDialog,
  ThinkingTonePainter,
  type UiRenderCapabilities,
  type UiRenderClock,
  type UiRenderDriverHandle,
  type UiSnapshot,
  type UiWidgetEntry,
  UiWidgetHost
} from '@pi/lib/ui'
import { cloneSlabConfig, defaultSlabConfig, loadSlabConfig, saveSlabConfig } from './config.ts'
import { SlabEditor, type SlabRightRailState, type SlashCommandMatch } from './editor.ts'
import { renderSlabFooterLines } from './footer.ts'
import { collectGitSnapshot } from './git.ts'
import { readMcpStatusSnapshot, startMcpStatusPolling } from './mcp.ts'
import { SlabConfigPane } from './pane.ts'
import { createSlabRuntimeState } from './state.ts'
import type { SlabConfig, SlabGitSnapshot, SlabRuntimeState } from './types.ts'

export const SLAB_EXTENSION_NAME = 'slab' as const

const REDRAW_THROTTLE_MS = 60
const SHIMMER_INTERVAL_MS = 180
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

// Pi's builtin slash commands aren't exposed via pi.getCommands() — that one
// only returns extension/prompt/skill commands. We mirror the builtin list
// from pi-coding-agent's slash-commands.ts so the rainbow only fires when
// a real command is typed. If Pi adds a new builtin, add it here.
const BUILTIN_SLASH_COMMAND_NAMES: readonly string[] = [
  'settings',
  'model',
  'scoped-models',
  'export',
  'import',
  'share',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit'
]

interface SlabState {
  config: SlabConfig
  surface: SlabRuntimeState
  snapshot: UiSnapshot
  clock: UiRenderClock
}

function createState(
  ctx: ExtensionContext,
  config: SlabConfig,
  snapshot = getUiStatusStore().snapshot(),
  clock: UiRenderClock = { now: Date.now(), tick: 0 },
  git?: SlabGitSnapshot,
  thinking?: string
): SlabState {
  return {
    config,
    surface: createSlabRuntimeState(ctx, snapshot, clock, config, {
      git,
      thinking
    }),
    snapshot,
    clock
  }
}

function capabilities(): UiRenderCapabilities {
  const lang = process.env.LC_ALL || process.env.LANG || ''
  return {
    color: process.env.NO_COLOR === undefined,
    unicode: process.env.PI_SLAB_ASCII !== '1' && lang !== 'C'
  }
}

function clean(text: string, caps: UiRenderCapabilities): string {
  return caps.color ? text : text.replace(ANSI_PATTERN, '')
}

function fit(text: string, width: number, caps: UiRenderCapabilities): string {
  return truncateToWidth(clean(text, caps), Math.max(0, width), caps.unicode ? '…' : '...')
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

class SlabFooter implements Component {
  constructor(
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly getState: () => SlabState,
    private readonly widgetHost: UiWidgetHost,
    private readonly rightRail: SlabRightRailState
  ) {}

  render(width: number): string[] {
    const caps = capabilities()
    const state = this.getState()
    const rightWidgetLines = renderWidgetLines(this.widgetHost, state.snapshot.widgets, 'footerRight', width, caps, state.clock)
    return renderSlabFooterLines(
      this.footerData.getExtensionStatuses(),
      rightWidgetLines,
      width,
      caps,
      this.rightRail,
      readMcpStatusSnapshot()
    )
  }

  invalidate(): void {}

  dispose(): void {}
}

export default function slab(pi: ExtensionAPI): void {
  let config = defaultSlabConfig()
  let currentCtx: ExtensionContext | undefined
  let gitSnapshot: SlabGitSnapshot | undefined
  let recognizedCommands: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_NAMES)
  let shimmerTimer: ReturnType<typeof setInterval> | undefined
  let stopMcpStatusPolling: (() => void) | undefined

  function refreshCommandRegistry(): void {
    const names = new Set<string>(BUILTIN_SLASH_COMMAND_NAMES)
    try {
      const getter = (pi as { getCommands?: () => Array<{ name?: unknown }> }).getCommands
      const entries = typeof getter === 'function' ? getter.call(pi) : undefined
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry.name === 'string' && entry.name.length > 0) names.add(entry.name)
        }
      }
    } catch {
      // pi.getCommands() may not exist on older Pi versions — builtin set still covers most use.
    }
    recognizedCommands = names
  }

  function startShimmer(): void {
    if (shimmerTimer) return
    shimmerTimer = setInterval(() => {
      driver?.request()
    }, SHIMMER_INTERVAL_MS)
    ;(shimmerTimer as { unref?: () => void }).unref?.()
  }

  function stopShimmer(): void {
    if (!shimmerTimer) return
    clearInterval(shimmerTimer)
    shimmerTimer = undefined
  }

  function onEditorTextChange(_text: string, match: SlashCommandMatch | undefined): void {
    if (match) startShimmer()
    else stopShimmer()
  }

  function readThinkingLevel(): string {
    const getter = (pi as { getThinkingLevel?: () => unknown }).getThinkingLevel
    if (typeof getter !== 'function') return 'off'
    try {
      const value = getter.call(pi)
      return typeof value === 'string' ? value : 'off'
    } catch {
      return 'off'
    }
  }
  let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let gitRefreshInFlightCwd: string | undefined
  let gitRefreshQueuedCwd: string | undefined
  let gitRefreshGeneration = 0
  let state: SlabState | undefined
  let driver: UiRenderDriverHandle | undefined
  let widgetHost: UiWidgetHost | undefined
  let slabFooter: SlabFooter | undefined
  let rightRail: SlabRightRailState = {}
  let thinkingTonePainter: ThinkingTonePainter | undefined
  let renderRequested = false
  let applyConfigChain = Promise.resolve()
  let requestRender = () => {
    renderRequested = true
  }

  function getState(): SlabState {
    if (!state) throw new Error('slab state not initialized')
    return state
  }

  function currentCtxCwd(): string | undefined {
    try {
      return currentCtx?.cwd
    } catch {
      currentCtx = undefined
      return undefined
    }
  }

  function refresh(ctx: ExtensionContext, thinkingOverride?: string): void {
    currentCtx = ctx
    const snapshot = getUiStatusStore().snapshot()
    const clock = driver?.clock ?? state?.clock ?? { now: Date.now(), tick: 0 }
    const thinking = thinkingOverride ?? readThinkingLevel()
    state = createState(ctx, config, snapshot, clock, gitSnapshot, thinking)
    driver?.request()
  }

  function configKey(value: unknown): string {
    return JSON.stringify(value)
  }

  function gitSegmentEnabled(value: SlabConfig): boolean {
    return value.enabled && value.segments.some((segment) => segment.id === 'git' && segment.enabled)
  }

  function configNeedsGitRefresh(previous: SlabConfig, next: SlabConfig, ctx: ExtensionContext): boolean {
    if (!gitSegmentEnabled(next)) return false
    return (
      currentCtxCwd() !== ctx.cwd ||
      gitSegmentEnabled(previous) !== gitSegmentEnabled(next) ||
      configKey(previous.git) !== configKey(next.git)
    )
  }

  function applySlabConfig(ctx: ExtensionContext, nextConfig: SlabConfig): void {
    const previous = config
    const applied = cloneSlabConfig(nextConfig)
    if (configKey(previous) === configKey(applied)) return
    const refreshGit = configNeedsGitRefresh(previous, applied, ctx)
    config = applied
    if (!applied.enabled) {
      clear(ctx)
    } else if (driver && widgetHost) {
      refresh(ctx)
      if (refreshGit) requestGitRefresh(ctx)
    } else {
      state = createState(ctx, applied, undefined, undefined, gitSnapshot, readThinkingLevel())
      requestRender()
    }

    applyConfigChain = applyConfigChain
      .catch(() => {})
      .then(async () => {
        await saveSlabConfig(applied)
        if (applied.enabled && (!driver || !widgetHost) && ctx.hasUI) await install(ctx)
      })
      .catch((error) =>
        ctx.ui.notify(`slab config apply failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      )
  }

  function requestGitRefresh(ctx: ExtensionContext): void {
    requestGitRefreshForCwd(ctx.cwd)
  }

  function requestGitRefreshForCwd(cwd: string): void {
    gitRefreshQueuedCwd = cwd
    if (gitRefreshTimer || gitRefreshInFlightCwd) return
    gitRefreshTimer = setTimeout(
      () => {
        gitRefreshTimer = undefined
        const next = gitRefreshQueuedCwd
        gitRefreshQueuedCwd = undefined
        if (next) void runGitRefresh(next, gitRefreshGeneration)
      },
      Math.max(0, config.git.refreshDebounceMs)
    )
  }

  async function runGitRefresh(cwd: string, generation: number): Promise<void> {
    gitRefreshInFlightCwd = cwd
    try {
      const snapshot = await collectGitSnapshot(cwd, config.git)
      if (generation !== gitRefreshGeneration || currentCtxCwd() !== cwd) return
      gitSnapshot = snapshot
      if (currentCtx) refresh(currentCtx)
    } finally {
      gitRefreshInFlightCwd = undefined
      const next = gitRefreshQueuedCwd
      gitRefreshQueuedCwd = undefined
      if (next && generation === gitRefreshGeneration) requestGitRefreshForCwd(next)
    }
  }

  async function install(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return
    clear(ctx)
    config = await loadSlabConfig()
    if (!config.enabled) return
    currentCtx = ctx
    gitSnapshot = undefined
    state = createState(ctx, config, undefined, undefined, undefined, readThinkingLevel())
    widgetHost = new UiWidgetHost({ onInvalidate: () => requestRender() })
    rightRail = {}
    thinkingTonePainter?.dispose()
    thinkingTonePainter = new ThinkingTonePainter({
      onInput: (handler) => ctx.ui.onTerminalInput(handler),
      baseColor: 'thinkingXhigh',
      onResolved: () => driver?.request()
    })
    driver = createUiRenderDriver({
      store: getUiStatusStore(),
      throttleMs: REDRAW_THROTTLE_MS,
      render(clock, snapshot) {
        if (currentCtx) state = createState(currentCtx, config, snapshot, clock, gitSnapshot, readThinkingLevel())
        requestRender()
      }
    })
    requestGitRefresh(ctx)

    ctx.ui.setFooter((tui, _theme, footerData) => {
      requestRender = () => tui.requestRender()
      if (renderRequested) {
        renderRequested = false
        requestRender()
      }
      if (!widgetHost) throw new Error('slab widget host not initialized')
      slabFooter = new SlabFooter(footerData, getState, widgetHost, rightRail)
      return slabFooter
    })
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      requestRender = () => tui.requestRender()
      if (renderRequested) {
        renderRequested = false
        requestRender()
      }
      if (!widgetHost) throw new Error('slab widget host not initialized')
      const editor = new SlabEditor(tui, theme, keybindings, getState, widgetHost, rightRail, {
        recognizedCommands: () => recognizedCommands,
        selectionBackground: (text) => ctx.ui.theme.bg('selectedBg', text),
        paintThinkingBorder: (thinking, text) =>
          thinkingTonePainter?.paint(ctx.ui.theme, thinking, text) ?? ctx.ui.theme.getThinkingBorderColor('off')(text),
        onTextChange: onEditorTextChange
      })
      tui.setInputRenderScope(editor, () => (slabFooter ? [editor, slabFooter] : [editor]))
      requestRender = () => tui.requestRenderFor(editor)
      return editor
    })
    stopMcpStatusPolling = startMcpStatusPolling(() => requestRender())
    refreshCommandRegistry()
  }

  function clear(ctx: ExtensionContext): void {
    stopShimmer()
    stopMcpStatusPolling?.()
    stopMcpStatusPolling = undefined
    driver?.dispose()
    driver = undefined
    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined)
      ctx.ui.setEditorComponent(undefined)
    }
    widgetHost?.dispose()
    widgetHost = undefined
    slabFooter = undefined
    requestRender = () => {
      renderRequested = true
    }
    rightRail = {}
    thinkingTonePainter?.dispose()
    thinkingTonePainter = undefined
    currentCtx = undefined
    gitSnapshot = undefined
    gitRefreshGeneration++
    if (gitRefreshTimer) clearTimeout(gitRefreshTimer)
    gitRefreshTimer = undefined
    gitRefreshInFlightCwd = undefined
    gitRefreshQueuedCwd = undefined
  }

  pi.registerCommand('slab', {
    description: 'Configure the slab input surface.',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('/slab requires interactive UI', 'warning')
        return
      }
      const initial = await loadSlabConfig()
      openDialog(
        ctx,
        ({ theme, close }) => new SlabConfigPane(initial, theme, (next) => applySlabConfig(ctx, next), close),
        { width: '96%', maxHeight: '94%', padding: 0, borderStyle: 'square' }
      )
    }
  })

  pi.on('session_start', async (_event, ctx) => {
    await install(ctx)
  })

  pi.on('model_select', async (_event, ctx) => {
    refresh(ctx)
  })

  pi.on('thinking_level_select', async (event, ctx) => {
    const level = (event as { level?: unknown }).level
    refresh(ctx, typeof level === 'string' ? level : undefined)
  })

  pi.on('turn_start', async (_event, ctx) => {
    refresh(ctx)
  })

  pi.on('turn_end', async (_event, ctx) => {
    refresh(ctx)
    requestGitRefresh(ctx)
  })

  pi.on('tool_execution_end', async (_event, ctx) => {
    refresh(ctx)
    requestGitRefresh(ctx)
  })

  pi.on('message_end', async (_event, ctx) => {
    refresh(ctx)
  })

  pi.on('agent_end', async (_event, ctx) => {
    refresh(ctx)
    requestGitRefresh(ctx)
  })

  pi.on('session_tree', async (_event, ctx) => {
    refresh(ctx)
    requestGitRefresh(ctx)
  })

  pi.on('session_compact', async (_event, ctx) => {
    refresh(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    clear(ctx)
    state = undefined
  })
}
