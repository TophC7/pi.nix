import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { startOperation } from '@pi/lib/lock'
import { runRtkOptimizedCommand } from '@pi/lib/rtk'
import { headBytes } from '@pi/lib/subagents/output'
import { extractSubagentText, runSubagent } from '@pi/lib/subagents'
import { captureFreehandReviewContext, captureStagedReviewContext, MAX_DIFF_BYTES, splitZ, type ReviewContextCapture } from './context.ts'
import { reviewReportPrompt, reviewScoutTask } from './prompts.ts'
import { REVIEW_AGENT_REGISTRY } from './schema.ts'
import { synthesizeReview } from './synthesis.ts'

const REVIEW_REPORT_TOOLS = ['ask_user'] as const

interface ReviewRunArgs {
  context: ReviewContextCapture
  targetLabel: string
  targetRules: string
}

interface StagedDiffCapture {
  readonly text: string
  readonly notes: readonly string[]
  readonly error?: string
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
    captureStagedDiff(pi, ctx)
  ])
  if ((nameOnly.code ?? 1) !== 0) {
    ctx.ui.notify(`/review could not read staged files: ${nameOnly.stderr || 'git diff --staged --name-only failed'}`, 'error')
    return
  }
  const files = splitZ(nameOnly.stdout ?? '')
  if (diff.error) {
    ctx.ui.notify(`/review could not read staged diff: ${diff.error}`, 'error')
    return
  }

  const diffText = diff.text.trim()
  if (!diffText) {
    ctx.ui.notify('/review: no staged changes to review.', 'info')
    return
  }

  const reviewContext = captureStagedReviewContext(ctx, { diff: diffText, files, guidance, notes: diff.notes })
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

async function captureStagedDiff(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<StagedDiffCapture> {
  const rtk = await runRtkOptimizedCommand(pi, 'git diff --staged', {
    cwd: ctx.cwd,
    signal: ctx.signal,
    maxStdoutBytes: MAX_DIFF_BYTES,
    timeout: 30_000
  })
  if (rtk.used) {
    if (rtk.code !== 0) return { text: '', notes: rtk.notes, error: rtk.stderr || `RTK diff failed with exit ${rtk.code}` }
    return { text: rtk.stdout, notes: rtk.notes }
  }

  const fallback = await pi.exec('sh', ['-lc', `git diff --staged | head -c ${MAX_DIFF_BYTES + 1}`], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 30_000
  })
  if ((fallback.code ?? 1) !== 0) return { text: '', notes: rtk.notes, error: fallback.stderr || 'git diff --staged failed' }
  const capped = headBytes(fallback.stdout || '', MAX_DIFF_BYTES, `[truncated at ${MAX_DIFF_BYTES} bytes]`)
  const notes = [...rtk.notes, 'RTK optimized diff unavailable; used byte-limited raw git diff fallback.']
  if (capped.truncation) notes.push(`Staged diff truncated at ${MAX_DIFF_BYTES} bytes.`)
  return { text: capped.text, notes }
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
      startOperation(pi, 'review', REVIEW_REPORT_TOOLS)
    } catch (error) {
      ctx.ui.notify(`/review cannot start report turn: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }

    pi.sendUserMessage(reviewReportPrompt(synthesis.report), { deliverAs: 'followUp' })
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
    description: 'Run a read-only adversarial review of staged changes.',
    handler: async (args, ctx) => runReview(pi, ctx, args)
  })

  pi.registerCommand('review:freehand', {
    description: 'Run a read-only adversarial review from a prompt that names the target/scope.',
    handler: async (args, ctx) => runReviewFreehand(pi, ctx, args)
  })
}
