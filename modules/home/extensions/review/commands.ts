import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { startOperation } from '@pi/lib/lock'
import { captureOptimizedCommand } from '@pi/lib/rtk'
import { extractSubagentText, runSubagent } from '@pi/lib/subagents'
import {
  captureFreehandReviewContext,
  captureStagedReviewContext,
  MAX_DIFF_BYTES,
  splitZ,
  type ReviewContextCapture
} from './context.ts'
import { reviewReportPrompt, reviewScoutTask } from './prompts.ts'
import { REVIEW_AGENT_REGISTRY } from './schema.ts'
import { synthesizeReview } from './synthesis.ts'

const REVIEW_TRIAGE_TOOLS = [
  'read',
  'grep',
  'find',
  'ls',
  'bash',
  'edit',
  'write',
  'ask_user',
  'context_mode_ctx_execute',
  'context_mode_ctx_execute_file',
  'ctx_execute',
  'ctx_execute_file'
] as const

interface ReviewRunArgs {
  context: ReviewContextCapture
  targetLabel: string
  targetRules: string
}

export async function runReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const guidance = args?.trim() || undefined

  const repoCheck = await pi.exec('git', ['rev-parse', '--git-dir'], {
    cwd: ctx.cwd,
    signal: ctx.signal
  })
  if ((repoCheck.code ?? 1) !== 0) {
    ctx.ui.notify('/review requires a git repository.', 'error')
    return
  }

  const [nameOnly, diff] = await Promise.all([
    pi.exec('git', ['diff', '--staged', '--name-only', '-z'], {
      cwd: ctx.cwd,
      signal: ctx.signal
    }),
    captureOptimizedCommand(pi, 'git diff --staged', {
      cwd: ctx.cwd,
      signal: ctx.signal,
      maxBytes: MAX_DIFF_BYTES
    })
  ])
  if ((nameOnly.code ?? 1) !== 0) {
    ctx.ui.notify(
      `/review could not read staged files: ${nameOnly.stderr || 'git diff --staged --name-only failed'}`,
      'error'
    )
    return
  }
  const files = splitZ(nameOnly.stdout ?? '')
  if (diff.error) {
    ctx.ui.notify(`/review could not read staged diff: ${diff.error}`, 'error')
    return
  }

  const diffText = diff.output.trim()
  if (!diffText) {
    ctx.ui.notify('/review: no staged changes to review.', 'info')
    return
  }

  const reviewContext = captureStagedReviewContext(ctx, {
    diff: diffText,
    files,
    guidance,
    notes: diff.notes
  })
  await runReviewPipeline(pi, ctx, {
    context: reviewContext,
    targetLabel: 'staged changes',
    targetRules: [
      '- Review only the staged diff in context.',
      '- Use surrounding files only to decide whether staged code is correct.',
      '- Treat command arguments as guidance, not as a target override.'
    ].join('\n')
  })
}

export async function runReviewFreehand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const prompt = args?.trim() ?? ''
  if (!prompt) {
    ctx.ui.notify('Usage: /review:freehand <prompt telling the reviewer where/how to inspect>', 'warning')
    return
  }

  const reviewContext = captureFreehandReviewContext(ctx, { prompt })
  await runReviewPipeline(pi, ctx, {
    context: reviewContext,
    targetLabel: 'freehand prompt',
    targetRules: [
      '- The user prompt is the target and scope.',
      '- Inspect only files, areas, or behaviors named by the prompt or directly required to verify them.',
      '- Do not infer a broad repository-wide review target beyond the prompt.',
      '- If the prompt is too vague to anchor a finding, return no findings and leave assumptions in the final report.'
    ].join('\n')
  })
}

async function runReviewPipeline(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: ReviewRunArgs): Promise<void> {
  try {
    const truncationSuffix = args.context.truncated ? ` Context notes: ${args.context.notes.join(' ')}` : ''
    ctx.ui.notify(
      `/review: launching ${REVIEW_AGENT_REGISTRY.length} read-only scouts for ${args.targetLabel}.${truncationSuffix}`,
      'info'
    )

    const response = await runSubagent(
      pi,
      ctx,
      {
        tasks: REVIEW_AGENT_REGISTRY.map(({ agent, scope }) => ({
          agent,
          task: reviewScoutTask({
            scope,
            context: args.context.content,
            targetLabel: args.targetLabel,
            targetRules: args.targetRules
          })
        })),
        context: 'fresh',
        agentScope: 'both'
      },
      '/review scouts',
      'review-subagents'
    )

    const synthesis = synthesizeReview({
      rawFindings: extractSubagentText(response),
      targetLabel: args.targetLabel,
      contextNotes: args.context.notes
    })

    try {
      startOperation(pi, 'review', REVIEW_TRIAGE_TOOLS)
    } catch (error) {
      ctx.ui.notify(
        `/review cannot start triage turn: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return
    }

    pi.sendUserMessage(reviewReportPrompt(synthesis.report), {
      deliverAs: 'followUp'
    })
    ctx.ui.notify(
      `/review: scouts complete; ${synthesis.findings.length} finding(s), ${synthesis.quarantined.length} quarantined card(s).`,
      'info'
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`/review error: ${message}`, 'error')
    throw error
  }
}

export function registerReviewCommands(pi: ExtensionAPI): void {
  pi.registerCommand('review', {
    description: 'Run adversarial review of staged changes, triage findings, and apply selected fixes.',
    handler: async (args, ctx) => runReview(pi, ctx, args)
  })

  pi.registerCommand('review:freehand', {
    description: 'Run adversarial review from a prompt, triage findings, and apply selected fixes.',
    handler: async (args, ctx) => runReviewFreehand(pi, ctx, args)
  })
}
