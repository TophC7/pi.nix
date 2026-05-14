import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { workflowController } from '../workflow/controller.ts'

export type HandoffPolicy = 'auto' | 'confirm' | 'manual'

export type HandoffOutcome =
  | { kind: 'success'; mode: 'direct-helper' }
  | { kind: 'queued_unverified'; mode: 'prompt-follow-up' }
  | { kind: 'manual_pending' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: unknown }

export type HandoffContext = ExtensionContext & {
  waitForIdle?: () => Promise<void>
}

export interface HandoffOptions<C extends HandoffContext = HandoffContext> {
  readonly pi: ExtensionAPI
  readonly ctx: C
  readonly label: string
  readonly command?: string
  readonly helper?: (ctx: C) => Promise<unknown> | unknown
  readonly prompt?: string
  readonly policy: HandoffPolicy
  readonly reason?: string
}

export function fireAndForgetHandoffReason(): string {
  return 'Pi extension sendUserMessage is fire-and-forget in this version; it cannot prove queue acceptance or slash-command execution.'
}

export async function handoff<C extends HandoffContext>(options: HandoffOptions<C>): Promise<HandoffOutcome> {
  if (options.policy === 'manual') return stageManual(options)
  if (options.policy === 'confirm') return confirmHandoff(options)
  return runHandoff(options)
}

// Single shared agent_end listener per ExtensionAPI drains a queue of one-shot
// callbacks. pi.on has no off handle, so per-call listeners would leak.
const pendingAgentEnd = new WeakMap<ExtensionAPI, Array<(ctx: ExtensionContext) => Promise<void> | void>>()
const agentEndRegistered = new WeakSet<ExtensionAPI>()

export async function deferToAgentEnd(
  pi: ExtensionAPI,
  fn: (ctx: ExtensionContext) => Promise<void> | void
): Promise<void> {
  let queue = pendingAgentEnd.get(pi)
  if (!queue) {
    queue = []
    pendingAgentEnd.set(pi, queue)
  }
  queue.push(fn)
  if (agentEndRegistered.has(pi)) return
  agentEndRegistered.add(pi)
  pi.on('agent_end', async (_event, ctx) => {
    const pending = pendingAgentEnd.get(pi)
    if (!pending || pending.length === 0) return
    const drained = pending.splice(0, pending.length)
    for (const cb of drained) {
      await cb(ctx)
    }
  })
}

async function confirmHandoff<C extends HandoffContext>(options: HandoffOptions<C>): Promise<HandoffOutcome> {
  markAwaitingConfirmation(options)
  const choice = await chooseConfirmation(options)
  if (choice === 'cancel') return cancelHandoff(options)
  if (choice === 'edit') return stageManual(options)
  return runHandoff(options)
}

async function runHandoff<C extends HandoffContext>(options: HandoffOptions<C>): Promise<HandoffOutcome> {
  await options.ctx.waitForIdle?.()
  if (options.helper) return runDirectHelper(options)
  if (options.prompt) return sendPromptFollowUp(options)
  return failHandoff(options, new Error(`${options.label}: no direct helper or prompt continuation available.`))
}

async function runDirectHelper<C extends HandoffContext>(options: HandoffOptions<C>): Promise<HandoffOutcome> {
  const runId = workflowController.activeRun?.runId
  try {
    markContinuationQueued(options)
    await options.helper?.(options.ctx)
    releaseWorkflowRun(options.pi, options.ctx, options.label, runId, `${options.label}: direct-helper complete`)
    return { kind: 'success', mode: 'direct-helper' }
  } catch (error) {
    return failHandoff(options, error)
  }
}

function sendPromptFollowUp<C extends HandoffContext>(options: HandoffOptions<C>): HandoffOutcome {
  const prompt = options.prompt?.trim() ?? ''
  if (!prompt) return failHandoff(options, new Error(`${options.label}: prompt continuation is empty.`))
  if (isSlashLike(prompt)) {
    return failHandoff(
      options,
      new Error(`${options.label}: slash text cannot be sent through fire-and-forget prompt handoff.`)
    )
  }
  const runId = workflowController.activeRun?.runId
  try {
    markContinuationQueued(options)
    options.pi.sendUserMessage(prompt, { deliverAs: 'followUp' })
    if (runId)
      deferToAgentEnd(options.pi, (ctx) =>
        releaseWorkflowRun(options.pi, ctx, options.label, runId, `${options.label}: follow-up agent_end`)
      )
    options.ctx.ui.notify(`${options.label}: continuation queued (unverified).`, 'info')
    return { kind: 'queued_unverified', mode: 'prompt-follow-up' }
  } catch (error) {
    return failHandoff(options, error)
  }
}

function stageManual<C extends HandoffContext>(options: HandoffOptions<C>): HandoffOutcome {
  const text = options.command ?? options.prompt
  if (!text?.trim())
    return failHandoff(options, new Error(`${options.label}: no command or prompt available for manual handoff.`))
  const runId = workflowController.activeRun?.runId
  try {
    options.ctx.ui.setEditorText(text)
    markManualPending(options)
    options.ctx.ui.notify(
      [
        `${options.label}: manual handoff staged.`,
        options.reason ? `Reason: ${options.reason}` : undefined,
        'Edit if needed, then press Enter.'
      ]
        .filter(Boolean)
        .join('\n'),
      'warning'
    )
    releaseWorkflowRun(options.pi, options.ctx, options.label, runId, `${options.label}: manual staged`)
    return { kind: 'manual_pending' }
  } catch (error) {
    return failHandoff(options, error)
  }
}

async function chooseConfirmation<C extends HandoffContext>(
  options: HandoffOptions<C>
): Promise<'run' | 'edit' | 'cancel'> {
  if (typeof options.ctx.ui.select !== 'function') return 'run'
  const choice = await options.ctx.ui.select(`${options.label}: choose handoff action`, ['Run', 'Edit', 'Cancel'])
  if (choice === 'Edit') return 'edit'
  if (choice === 'Cancel') return 'cancel'
  return 'run'
}

function cancelHandoff<C extends HandoffContext>(options: HandoffOptions<C>): HandoffOutcome {
  try {
    if (workflowController.activeRun) workflowController.cancel(options.pi, options.ctx, `${options.label}: cancelled`)
  } catch (error) {
    return failHandoff(options, error)
  }
  options.ctx.ui.notify(`${options.label}: handoff cancelled.`, 'info')
  return { kind: 'cancelled' }
}

function failHandoff<C extends HandoffContext>(options: HandoffOptions<C>, error: unknown): HandoffOutcome {
  const message = error instanceof Error ? error.message : String(error)
  try {
    if (workflowController.activeRun) workflowController.fail(options.pi, options.ctx, error)
  } catch {
    // Preserve original handoff failure; workflow restore failure is surfaced by the controller.
  }
  options.ctx.ui.notify(`${options.label}: handoff failed: ${message}`, 'error')
  return { kind: 'failed', error }
}

function markAwaitingConfirmation<C extends HandoffContext>(options: HandoffOptions<C>): void {
  try {
    if (workflowController.status === 'active')
      workflowController.markAwaitingConfirmation(
        options.pi,
        options.ctx,
        options.reason ?? `${options.label}: awaiting_confirmation`
      )
  } catch (error) {
    options.ctx.ui.notify(`${options.label}: could not mark awaiting_confirmation: ${formatError(error)}`, 'warning')
  }
}

function markContinuationQueued<C extends HandoffContext>(options: HandoffOptions<C>): void {
  try {
    if (workflowController.status === 'active' || workflowController.status === 'awaiting_confirmation') {
      workflowController.markContinuationQueued(
        options.pi,
        options.ctx,
        options.reason ?? `${options.label}: continuation_queued`
      )
    }
  } catch (error) {
    options.ctx.ui.notify(`${options.label}: could not mark continuation_queued: ${formatError(error)}`, 'warning')
  }
}

function markManualPending<C extends HandoffContext>(options: HandoffOptions<C>): void {
  try {
    if (workflowController.status === 'active' || workflowController.status === 'awaiting_confirmation') {
      workflowController.markManualPending(
        options.pi,
        options.ctx,
        options.reason ?? `${options.label}: manual_pending`
      )
    }
  } catch (error) {
    options.ctx.ui.notify(`${options.label}: could not mark manual_pending: ${formatError(error)}`, 'warning')
  }
}

function releaseWorkflowRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  label: string,
  runId: string | undefined,
  reason: string
): void {
  if (!runId || workflowController.activeRun?.runId !== runId) return
  try {
    workflowController.exit(pi, ctx, reason)
  } catch (error) {
    ctx.ui.notify(`${label}: workflow restore failed: ${formatError(error)}`, 'error')
    throw error
  }
}

function isSlashLike(text: string): boolean {
  return text.trimStart().startsWith('/')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
