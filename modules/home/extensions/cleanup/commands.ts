import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { captureOptimizedCommand } from '@pi/lib/rtk'
import { startOperation } from '@pi/lib/lock'
import { extractSubagentText, runSubagent } from '@pi/lib/subagents'
import {
  cleanupApplyPrompt,
  cleanupEfficiencyTask,
  cleanupQualityTask,
  cleanupQuickPrompt,
  cleanupReuseTask
} from './prompts.ts'

const CLEANUP_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'] as const
const MAX_CLEANUP_DIFF_BYTES = 160 * 1024

interface DiffCapture {
  readonly text: string
  readonly error?: string
}

export async function runCleanup(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const focus = args?.trim() || undefined

  const repoCheck = await pi.exec('git', ['rev-parse', '--git-dir'], {
    cwd: ctx.cwd,
    signal: ctx.signal
  })
  if ((repoCheck.code ?? 1) !== 0) {
    ctx.ui.notify('/cleanup requires a git repository.', 'error')
    return
  }
  const status = await pi.exec('git', ['status', '--porcelain'], {
    cwd: ctx.cwd,
    signal: ctx.signal
  })
  if (!status.stdout.trim()) {
    ctx.ui.notify('/cleanup: no working-tree changes to review.', 'info')
    return
  }
  const diff = await captureWorkingTreeDiff(pi, ctx)
  if (diff.error) {
    ctx.ui.notify(`/cleanup could not read working-tree diff: ${diff.error}`, 'error')
    return
  }
  const diffText = diff.text.trim()
  if (!diffText) {
    ctx.ui.notify('/cleanup: working tree changes produced an empty diff.', 'warning')
    return
  }

  ctx.ui.notify('/cleanup: launching reuse, quality, and efficiency scouts.', 'info')

  try {
    const response = await runSubagent(
      pi,
      ctx,
      {
        tasks: [
          {
            agent: 'cleanup.cleanup-reuse-scout',
            task: cleanupReuseTask(diffText, focus)
          },
          {
            agent: 'cleanup.cleanup-quality-scout',
            task: cleanupQualityTask(diffText, focus)
          },
          {
            agent: 'cleanup.cleanup-efficiency-scout',
            task: cleanupEfficiencyTask(diffText, focus)
          }
        ],
        context: 'fresh',
        agentScope: 'both'
      },
      '/cleanup scouts',
      'cleanup-subagents'
    )
    const findings = extractSubagentText(response)

    try {
      startOperation(pi, 'cleanup', CLEANUP_TOOLS)
    } catch (error) {
      ctx.ui.notify(`/cleanup cannot start apply turn: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }

    pi.sendUserMessage(cleanupApplyPrompt({ diff: diffText, findings, focus }), { deliverAs: 'followUp' })
    ctx.ui.notify('/cleanup: scouts complete. Handing findings to agent for application.', 'info')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`/cleanup error: ${message}`, 'error')
    throw error
  }
}

async function captureWorkingTreeDiff(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<DiffCapture> {
  const result = await captureOptimizedCommand(pi, 'git diff HEAD', {
    cwd: ctx.cwd,
    signal: ctx.signal,
    maxBytes: MAX_CLEANUP_DIFF_BYTES
  })
  return { text: result.output, ...(result.error ? { error: result.error } : {}) }
}

export async function runCleanupQuick(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle()
  try {
    startOperation(pi, 'cleanup:quick', CLEANUP_TOOLS)
  } catch (error) {
    ctx.ui.notify(`/cleanup:quick cannot start: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  pi.sendUserMessage(cleanupQuickPrompt(), { deliverAs: 'followUp' })
  ctx.ui.notify('/cleanup:quick: handing obvious junk removal to agent.', 'info')
}

export function registerCleanupCommands(pi: ExtensionAPI): void {
  pi.registerCommand('cleanup', {
    description: 'Review changed files (reuse, quality, efficiency) and apply fixes.',
    handler: async (args, ctx) => runCleanup(pi, ctx, args)
  })

  pi.registerCommand('cleanup:quick', {
    description: 'Delete only obvious junk (console.log, debugger, unused imports, empty catches).',
    handler: async (_args, ctx) => runCleanupQuick(pi, ctx)
  })
}
