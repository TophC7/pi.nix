import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import {
  type AuthoringGuardMode,
  type AuthoringToolCallBlock,
  type AuthoringToolCallEvent,
  evaluateAuthoringToolCall
} from './authoring-policy.ts'
import { workflowController } from './controller.ts'
import { getWorkflowProfile, SAFE_DEFAULT_TOOLS } from './profiles.ts'
import { clearWorkflowUiStatus, publishWorkflowUiStatus } from './status.ts'
import { restoreWorkflowTools } from './tools.ts'
import type { WorkflowId, WorkflowProfile } from './types.ts'

export type {
  AuthoringGuardMode,
  AuthoringToolCallBlock,
  AuthoringToolCallEvent
} from './authoring-policy.ts'

export interface AuthoringGuardState<TMode extends WorkflowId> {
  mode: AuthoringGuardMode<TMode>
  snapshot?: string[]
}

export interface AuthoringGuardOptions<TMode extends WorkflowId> {
  readonly modes: readonly TMode[]
  readonly statusKey: string
  readonly statusLabel: string
}

export interface AuthoringGuard<TMode extends WorkflowId> {
  readonly state: AuthoringGuardState<TMode>
  setWorkflowStatus(ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void
  enterMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void
  exitMode(pi: ExtensionAPI, ctx: ExtensionContext): void
  maybeBlockAuthoringToolCall(event: AuthoringToolCallEvent): AuthoringToolCallBlock | undefined
  setupAuthoringGuard(pi: ExtensionAPI): void
}

export function createAuthoringGuard<TMode extends WorkflowId>(
  options: AuthoringGuardOptions<TMode>
): AuthoringGuard<TMode> {
  const state: AuthoringGuardState<TMode> = { mode: 'idle' }
  const modes = new Set<string>(options.modes)

  function profileForMode(mode: AuthoringGuardMode<TMode>): WorkflowProfile | undefined {
    if (mode === 'idle') return undefined
    if (!modes.has(mode)) throw new Error(`Mode ${mode} is not managed by this authoring guard.`)
    return getWorkflowProfile(mode)
  }

  function setWorkflowStatus(_ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void {
    if (mode === 'idle') {
      clearWorkflowUiStatus(options.statusKey)
      return
    }
    publishWorkflowUiStatus({
      key: options.statusKey,
      status: mode,
      label: `${options.statusLabel}: ${mode}`
    })
  }

  function enterMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: AuthoringGuardMode<TMode>): void {
    if (mode === 'idle') return exitMode(pi, ctx)
    if (state.mode === mode) return
    const profile = profileForMode(mode)
    if (!profile) throw new Error(`Missing workflow profile for ${mode}`)
    const run = workflowController.enter(pi, ctx, profile)
    state.mode = mode
    state.snapshot = [...run.previousActiveTools]
  }

  function exitMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
    try {
      if (workflowController.activeRun) {
        workflowController.exit(pi, ctx)
        return
      }
      const targetTools = state.snapshot ?? safeDefaultToolsAvailable(pi)
      try {
        restoreWorkflowTools(pi, { previousActiveTools: targetTools })
      } catch (error) {
        ctx.ui.notify(
          `Workflow exit fallback restore failed: ${error instanceof Error ? error.message : String(error)}`,
          'warning'
        )
      }
    } finally {
      setWorkflowStatus(ctx, 'idle')
      state.mode = 'idle'
      state.snapshot = undefined
    }
  }

  function maybeBlockAuthoringToolCall(event: AuthoringToolCallEvent): AuthoringToolCallBlock | undefined {
    return evaluateAuthoringToolCall(profileForMode(state.mode), state.mode, event)
  }

  function setupAuthoringGuard(pi: ExtensionAPI): void {
    pi.on('tool_call', maybeBlockAuthoringToolCall)
  }

  return {
    state,
    setWorkflowStatus,
    enterMode,
    exitMode,
    maybeBlockAuthoringToolCall,
    setupAuthoringGuard
  }
}

function safeDefaultToolsAvailable(pi: ExtensionAPI): readonly string[] {
  const all = new Set(pi.getAllTools().map((tool) => tool.name))
  return SAFE_DEFAULT_TOOLS.filter((name) => all.has(name))
}
