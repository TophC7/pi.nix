import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { fireAndForgetHandoffReason, handoff } from '@pi/lib/handoff'
import {
  applyCommandConfig,
  captureRestore,
  getCommandConfig,
  restoreCommandConfig,
  type ManagedCommand,
  type RestoreState
} from './config'
import { COMMIT_PROMPT, PR_PROMPT } from './prompts'

export type PromptCommand = 'commit' | 'pr'

const PROMPTS: Record<PromptCommand, string> = {
  commit: COMMIT_PROMPT,
  pr: PR_PROMPT
}

let pendingRestore: RestoreState | undefined
const installed = new WeakSet<ExtensionAPI>()

function buildPrompt(command: PromptCommand, basePrompt: string, userPrompt: string | undefined): string {
  const trimmed = userPrompt?.trim()
  if (!trimmed) return basePrompt
  return `${basePrompt}\n\nAdditional user instructions from /${command} prompt. Follow only when they do not conflict with rules above:\n${trimmed}`
}

export function installCommandRuntime(pi: ExtensionAPI): void {
  if (installed.has(pi)) return
  installed.add(pi)

  pi.on('agent_end', async (_event, ctx) => {
    if (!pendingRestore) return
    const restore = pendingRestore
    pendingRestore = undefined
    await restoreCommandConfig(pi, restore)
    ctx.ui.notify(`/${restore.command} config restored`, 'info')
  })
}

export async function runCommit(pi: ExtensionAPI, ctx: ExtensionCommandContext, userPrompt?: string): Promise<void> {
  return runPromptCommand(pi, ctx, 'commit', userPrompt)
}

export async function runPr(pi: ExtensionAPI, ctx: ExtensionCommandContext, userPrompt?: string): Promise<void> {
  return runPromptCommand(pi, ctx, 'pr', userPrompt)
}

export async function runPromptCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: PromptCommand,
  userPrompt?: string
): Promise<void> {
  installCommandRuntime(pi)
  await ctx.waitForIdle()

  const config = getCommandConfig(command)
  const shouldRestore = Boolean(config.model || config.thinking)
  if (shouldRestore) pendingRestore = captureRestore(pi, ctx, command as ManagedCommand)
  if (!(await applyCommandConfig(pi, ctx, command, config))) {
    pendingRestore = undefined
    return
  }

  const restore = pendingRestore
  const outcome = await handoff({
    pi,
    ctx,
    label: `/${command}`,
    prompt: buildPrompt(command, PROMPTS[command], userPrompt),
    policy: 'confirm',
    reason: `${fireAndForgetHandoffReason()} Model/thinking config stays active until the queued handoff turn reaches agent_end; edit/manual paths restore immediately and may need a rerun if a custom /${command} model is required.`
  })

  if (outcome.kind === 'queued_unverified') return

  pendingRestore = undefined
  await restoreCommandConfig(pi, restore)
}
