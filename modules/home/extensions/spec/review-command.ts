import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { fireAndForgetHandoffReason, handoff } from '@pi/lib/handoff'
import { extractSubagentText, runSubagent } from '@pi/lib/subagents'
import { enterMode, exitMode } from './mode.ts'
import { reviewFinalizePrompt } from './prompts.ts'
import { captureReviewContext } from './review-context.ts'
import { validateReviewPlanDraft } from './review-plan-validator.ts'
import { REVIEW_AGENT_REGISTRY, type ReviewScope } from './review-schema.ts'
import { synthesizeReview } from './review-synthesis.ts'
import { formatReviewTarget, parseReviewTarget, REVIEW_TARGET_USAGE, type ReviewTarget } from './review-targets.ts'
import { makeStageDir, writeStage } from './stage.ts'

function parseReviewArgs(args: string | undefined): 'help' | 'exit' | string {
  const trimmed = args?.trim() ?? ''
  if (trimmed === 'help' || trimmed === '--help' || trimmed === '-h') return 'help'
  if (trimmed === 'exit' || trimmed === 'cancel') return 'exit'
  return trimmed
}

async function captureTarget(ctx: ExtensionCommandContext, initialTarget: string): Promise<string | undefined> {
  if (initialTarget) return initialTarget
  if (typeof ctx.ui.select === 'function') {
    const choice = await ctx.ui.select('/plan:review — pick a target kind', [
      'working-tree',
      'staged',
      'range <base>..<head>',
      'branch <name> [base]',
      'paths <path...>',
      'paste',
      'freeform <path>',
      'freeform grammar',
      'cancel'
    ])
    if (!choice || choice === 'cancel') return undefined
    return await collectGuidedTarget(ctx, choice)
  }
  const entered = await ctx.ui.input('/plan:review target', 'Review target (example: working-tree)')
  const target = entered?.trim() ?? ''
  return target || undefined
}

async function collectGuidedTarget(ctx: ExtensionCommandContext, choice: string): Promise<string | undefined> {
  if (choice === 'working-tree' || choice === 'staged' || choice === 'paste') return choice
  if (choice.startsWith('range')) {
    const value = (await ctx.ui.input('range', 'Enter <base>..<head>'))?.trim()
    return value ? `range ${value}` : undefined
  }
  if (choice.startsWith('branch')) {
    const name = (await ctx.ui.input('branch', 'Branch name'))?.trim()
    if (!name) return undefined
    const base = (await ctx.ui.input('branch base (optional)', 'Base ref or empty'))?.trim() ?? ''
    return base ? `branch ${name} ${base}` : `branch ${name}`
  }
  if (choice.startsWith('paths')) {
    const value = (await ctx.ui.input('paths', 'Space-separated paths'))?.trim()
    return value ? `paths ${value}` : undefined
  }
  if (choice.startsWith('freeform <')) {
    const value = (await ctx.ui.input('freeform', 'Path to context file'))?.trim()
    return value ? `freeform ${value}` : undefined
  }
  if (choice === 'freeform grammar') {
    const entered = (await ctx.ui.input('freeform grammar', 'Full target string'))?.trim()
    return entered || undefined
  }
  return undefined
}

async function parseReviewTargetWithPasteBody(
  ctx: ExtensionCommandContext,
  targetText: string
): Promise<ReturnType<typeof parseReviewTarget>> {
  if (targetText.trim() !== 'paste') return parseReviewTarget(targetText)
  const content = await ctx.ui.editor('Paste review content', '')
  if (!content?.trim()) return { ok: false, error: "Target 'paste' requires non-empty content." }
  return { ok: true, target: { kind: 'paste', content } }
}

function reviewAgentTask(scope: ReviewScope, target: ReviewTarget, contextPath: string): string {
  return [
    `Review scope: ${scope}`,
    `Target: ${formatReviewTarget(target)}`,
    `Context file: ${contextPath}`,
    '',
    'Read the context file first, then inspect only repository files needed to verify findings.',
    'Return review cards for this scope only, using your required schema. If no findings, return exactly `No findings.`.'
  ].join('\n')
}

export async function runPlanReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const command = parseReviewArgs(args)
  if (command === 'help') {
    ctx.ui.notify(
      `Usage: /plan:review <target> where target is ${REVIEW_TARGET_USAGE}. Use /plan:review exit to restore tools.`,
      'info'
    )
    return
  }
  if (command === 'exit') {
    exitMode(pi, ctx)
    ctx.ui.notify('Plan review mode exited.', 'info')
    return
  }

  enterMode(pi, ctx, 'plan-review-authoring')
  try {
    const targetText = await captureTarget(ctx, command)
    if (!targetText) {
      exitMode(pi, ctx)
      ctx.ui.notify('/plan:review cancelled: no target provided.', 'warning')
      return
    }
    let parsed = await parseReviewTargetWithPasteBody(ctx, targetText)
    if (!parsed.ok) {
      ctx.ui.notify(`/plan:review target parse failed: ${parsed.error}. Falling back to guided picker.`, 'warning')
      const retryText = await captureTarget(ctx, '')
      if (!retryText) {
        exitMode(pi, ctx)
        ctx.ui.notify('/plan:review cancelled.', 'warning')
        return
      }
      parsed = await parseReviewTargetWithPasteBody(ctx, retryText)
      if (!parsed.ok) {
        exitMode(pi, ctx)
        ctx.ui.notify(`/plan:review invalid target: ${parsed.error}`, 'error')
        return
      }
    }
    const stageDir = makeStageDir('plan-review')
    const context = await captureReviewContext(pi, ctx, parsed.target)
    const contextPath = writeStage(stageDir, 'context', context.content)
    const suffix = context.truncated ? ` Truncation notes: ${context.notes.join(' ')}` : ''
    ctx.ui.notify(
      `/plan:review target resolved: ${formatReviewTarget(parsed.target)}. Context captured at ${contextPath} (${context.bytes} bytes). Launching six review agents.${suffix}`,
      'info'
    )
    const response = await runSubagent(
      pi,
      ctx,
      {
        tasks: REVIEW_AGENT_REGISTRY.map(({ agent, scope }) => ({
          agent,
          task: reviewAgentTask(scope, parsed.target, contextPath)
        })),
        context: 'fresh',
        agentScope: 'both'
      },
      '/plan:review agents',
      'spec-subagents'
    )
    const rawFindings = extractSubagentText(response)
    const findingsPath = writeStage(stageDir, 'raw-findings', rawFindings)
    const synthesis = synthesizeReview(rawFindings, parsed.target)
    const draftValidation = validateReviewPlanDraft(synthesis.planDraft, {
      requireHardening: false
    })
    if (!draftValidation.valid)
      throw new Error(`Generated review plan draft failed validation:\n${draftValidation.errors.join('\n')}`)
    const reportPath = writeStage(stageDir, 'report', synthesis.report)
    if (synthesis.quarantined.length > 0) {
      ctx.ui.notify(
        `/plan:review quarantined ${synthesis.quarantined.length} malformed card(s); see Quarantined cards section in ${reportPath}.`,
        'warning'
      )
    }
    if (synthesis.findings.length === 0) {
      const choice = await ctx.ui.select('/plan:review found no issues', ['report only', 'create empty plan draft'])
      if (choice === 'create empty plan draft') {
        const planDraftPath = writeStage(stageDir, 'plan-draft', synthesis.planDraft)
        ctx.ui.notify(
          `/plan:review agents complete with no findings. Report: ${reportPath}. Empty draft created by user opt-in: ${planDraftPath}.`,
          'info'
        )
        await handoff({
          pi,
          ctx,
          label: '/plan:review finalize',
          prompt: reviewFinalizePrompt({
            target: formatReviewTarget(parsed.target),
            reportPath,
            planDraftPath
          }),
          policy: 'auto',
          reason: fireAndForgetHandoffReason()
        })
      } else {
        ctx.ui.notify(
          `/plan:review agents complete with no findings. Report: ${reportPath}. No plan draft created.`,
          'info'
        )
        exitMode(pi, ctx)
      }
      return
    }
    const planDraftPath = writeStage(stageDir, 'plan-draft', synthesis.planDraft)
    ctx.ui.notify(
      `/plan:review agents complete. Raw findings: ${findingsPath}. Report: ${reportPath}. Plan-compatible draft: ${planDraftPath}. Manual handoff prepared for hardening and save.`,
      'info'
    )
    await handoff({
      pi,
      ctx,
      label: '/plan:review finalize',
      prompt: reviewFinalizePrompt({
        target: formatReviewTarget(parsed.target),
        reportPath,
        planDraftPath
      }),
      policy: 'auto',
      reason: fireAndForgetHandoffReason()
    })
  } catch (error) {
    exitMode(pi, ctx)
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`/plan:review failed: ${message}`, 'error')
  }
}

export function registerPlanReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand('plan:review', {
    description:
      'Draft adversarial review plan from a target. Args: working-tree, staged, range, branch, paths, paste, freeform.',
    getArgumentCompletions: (prefix: string) =>
      ['working-tree', 'staged', 'range ', 'branch ', 'paths ', 'paste', 'freeform ', 'exit', 'help']
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value.trim() || value })),
    handler: async (args, ctx) => runPlanReview(pi, ctx, args)
  })
}
