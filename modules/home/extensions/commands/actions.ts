import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { deferToAgentEnd } from '@pi/lib/agent-end'
import {
  applyCommandConfig,
  captureRestore,
  getCommandConfig,
  restoreCommandConfig,
  type ManagedCommand
} from './config'
import { COMMIT_PROMPT, PR_PROMPT } from './prompts'

export type PromptCommand = 'commit' | 'pr'

const PROMPTS: Record<PromptCommand, string> = {
  commit: COMMIT_PROMPT,
  pr: PR_PROMPT
}

function buildPrompt(command: PromptCommand, basePrompt: string, userPrompt: string | undefined): string {
  const trimmed = userPrompt?.trim()
  if (!trimmed) return basePrompt
  return `${basePrompt}\n\nAdditional user instructions from /${command} prompt. Follow only when they do not conflict with rules above:\n${trimmed}`
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
  await ctx.waitForIdle()

  const config = getCommandConfig(command)
  const shouldRestore = Boolean(config.model || config.thinking)
  const restore = shouldRestore ? captureRestore(pi, ctx, command as ManagedCommand) : undefined
  if (!(await applyCommandConfig(pi, ctx, command, config))) return

  const prompt = buildPrompt(command, PROMPTS[command], userPrompt)
  pi.sendUserMessage(prompt, { deliverAs: 'followUp' })

  if (restore) {
    await deferToAgentEnd(pi, async (endCtx) => {
      await restoreCommandConfig(pi, restore)
      endCtx.ui.notify(`/${restore.command} config restored`, 'info')
    })
  }
}
