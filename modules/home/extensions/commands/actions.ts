import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { deferToAgentEnd } from '@pi/lib/agent-end'
import { captureOptimizedCommand as captureOptimizedCommandShared, type CommandCapture } from '@pi/lib/rtk'
import {
  applyMainRuntimeProfile,
  captureMainRuntimeProfile,
  formatRuntimeProfileError,
  hasRuntimeProfileSettings,
  restoreMainRuntimeProfile
} from '@pi/lib/runtime-profile'
import { headBytes } from '@pi/lib/subagents/output'
import { CONFIG_PATH, getCommandConfig } from './config'
import { COMMIT_PROMPT, PR_PROMPT } from './prompts'

export type PromptCommand = 'commit' | 'pr'

const PROMPTS: Record<PromptCommand, string> = {
  commit: COMMIT_PROMPT,
  pr: PR_PROMPT
}

const MAX_COMMAND_CONTEXT_BYTES = 96 * 1024

function buildPrompt(
  command: PromptCommand,
  basePrompt: string,
  preCollectedContext: string,
  userPrompt: string | undefined
): string {
  const parts = [basePrompt, preCollectedContext]
  const trimmed = userPrompt?.trim()
  if (trimmed) {
    parts.push(
      `Additional user instructions from /${command} prompt. Follow only when they do not conflict with rules above:\n${trimmed}`
    )
  }
  return parts.join('\n\n')
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

  const preCollectedContext = await collectPromptContext(pi, ctx, command)
  if (!preCollectedContext) return

  let restore: ReturnType<typeof captureMainRuntimeProfile> | undefined
  try {
    const config = getCommandConfig(command)
    restore = hasRuntimeProfileSettings(config) ? captureMainRuntimeProfile(pi, ctx, `/${command}`) : undefined
    await applyMainRuntimeProfile(pi, ctx, config, { source: `${CONFIG_PATH} /${command}` })
  } catch (error) {
    ctx.ui.notify(formatRuntimeProfileError(error), 'error')
    return
  }

  const prompt = buildPrompt(command, PROMPTS[command], preCollectedContext, userPrompt)
  pi.sendUserMessage(prompt, { deliverAs: 'followUp' })

  if (restore) {
    const restoreState = restore
    await deferToAgentEnd(pi, async (endCtx) => {
      await restoreMainRuntimeProfile(pi, restoreState)
      endCtx.ui.notify(`${restoreState.label} config restored`, 'info')
    })
  }
}

async function collectPromptContext(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: PromptCommand
): Promise<string | undefined> {
  if (command === 'commit') return collectCommitContext(pi, ctx)
  return collectPrContext(pi, ctx)
}

async function collectCommitContext(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const [stat, diff] = await Promise.all([
    captureOptimizedCommand(pi, ctx, 'git diff --cached --stat', MAX_COMMAND_CONTEXT_BYTES),
    captureOptimizedCommand(pi, ctx, 'git diff --cached', MAX_COMMAND_CONTEXT_BYTES)
  ])
  if (stat.error || diff.error) {
    ctx.ui.notify(`/commit could not collect staged context: ${stat.error || diff.error}`, 'error')
    return undefined
  }
  if (!diff.output.trim()) {
    ctx.ui.notify('/commit: nothing is staged.', 'info')
    return undefined
  }

  return formatPreCollectedContext('/commit pre-collected staged context', [
    'Staged diff is non-empty. /commit verified this before starting the agent turn.',
    'Draft the message from this context; do not rerun git diff or git status for staging decisions.',
    'Only the final git commit command remains for the agent to run.',
    formatCapture(stat),
    formatCapture(diff),
    formatNotes([stat, diff])
  ])
}

async function collectPrContext(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const [branch, status, upstream] = await Promise.all([
    captureRawCommand(pi, ctx, 'git branch --show-current', ['git', 'branch', '--show-current'], MAX_COMMAND_CONTEXT_BYTES),
    captureOptimizedCommand(pi, ctx, 'git status --short', MAX_COMMAND_CONTEXT_BYTES),
    captureOptionalRawCommand(
      pi,
      ctx,
      'git rev-parse --abbrev-ref @{upstream}',
      ['git', 'rev-parse', '--abbrev-ref', '@{upstream}'],
      '<none>',
      MAX_COMMAND_CONTEXT_BYTES
    )
  ])
  const preRangeError = [branch, status].find((capture) => capture.error)?.error
  if (preRangeError) {
    ctx.ui.notify(`/pr could not collect branch context: ${preRangeError}`, 'error')
    return undefined
  }

  const branchName = branch.output.trim()
  const base = await resolvePrBaseBranch(pi, ctx, branchName)
  const baseBranch = base.output.trim()
  const baseRange = `${baseBranch}..HEAD`
  const diffRange = `${baseBranch}...HEAD`
  const [commitCount, commits, diffStat] = await Promise.all([
    captureRawCommand(pi, ctx, `git rev-list --count ${baseRange}`, ['git', 'rev-list', '--count', baseRange], MAX_COMMAND_CONTEXT_BYTES),
    captureOptimizedCommand(pi, ctx, `git log --oneline ${quoteShellArg(baseRange)}`, MAX_COMMAND_CONTEXT_BYTES),
    captureOptimizedCommand(pi, ctx, `git diff ${quoteShellArg(diffRange)} --stat`, MAX_COMMAND_CONTEXT_BYTES)
  ])
  const error = [commitCount, commits, diffStat].find((capture) => capture.error)?.error
  if (error) {
    ctx.ui.notify(`/pr could not collect branch context: ${error}`, 'error')
    return undefined
  }

  const count = Number.parseInt(commitCount.output.trim(), 10)
  if (!Number.isFinite(count) || count <= 0) {
    ctx.ui.notify(`/pr: no commits exist between ${baseBranch} and HEAD.`, 'info')
    return undefined
  }

  const prBranch = branchName.startsWith('dev/') ? suggestedPrBranchName(branchName) : branchName || '<current branch>'
  const dirty = Boolean(status.output.trim())

  return formatPreCollectedContext('/pr pre-collected branch context', [
    `Base branch: ${baseBranch}`,
    `${count} commit${count === 1 ? '' : 's'} exist between ${baseBranch} and HEAD. /pr verified this before starting the agent turn.`,
    dirty ? 'Uncommitted changes are present; warn briefly but use committed context only.' : 'No uncommitted changes were reported.',
    branchName.startsWith('dev/')
      ? `Current branch is local-only dev branch. Suggested PR branch pointer: ${prBranch}`
      : `Use current branch as PR branch: ${prBranch}`,
    'Use this context for title/body and branch decisions; do not rerun branch inspection commands.',
    'Only allowed mutations remain: create PR branch pointer when needed, push once if needed, then run gh pr create.',
    formatCapture(branch),
    formatCapture(base),
    formatCapture(upstream),
    formatCapture(commitCount),
    formatCapture(commits),
    formatCapture(diffStat),
    formatCapture(status),
    formatNotes([branch, base, upstream, commitCount, commits, diffStat, status])
  ])
}

async function resolvePrBaseBranch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  branchName: string
): Promise<CommandCapture> {
  if (branchName) {
    const configured = await pi.exec('git', ['config', '--get', `branch.${branchName}.gh-merge-base`], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 30_000
    })
    const configuredBase = (configured.stdout ?? '').trim()
    if ((configured.code ?? 1) === 0 && configuredBase) return { label: 'PR base branch', output: configuredBase, notes: [] }
  }

  const originHead = await pi.exec('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 30_000
  })
  const defaultBranch = (originHead.stdout ?? '').trim().replace(/^origin\//, '')
  return { label: 'PR base branch', output: (originHead.code ?? 1) === 0 && defaultBranch ? defaultBranch : 'main', notes: [] }
}

function captureOptimizedCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
  maxBytes: number
): Promise<CommandCapture> {
  return captureOptimizedCommandShared(pi, command, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    maxBytes,
    timeout: 30_000
  })
}

async function captureRawCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  label: string,
  argv: readonly string[],
  maxBytes: number
): Promise<CommandCapture> {
  const [command, ...args] = argv
  if (!command) return { label, output: '', error: 'empty command', notes: [] }
  const result = await pi.exec(command, args, { cwd: ctx.cwd, signal: ctx.signal, timeout: 30_000 })
  if ((result.code ?? 1) !== 0) return { label, output: '', error: result.stderr || `${label} failed with exit ${result.code}`, notes: [] }
  const capped = headBytes(result.stdout ?? '', maxBytes, `[truncated at ${maxBytes} bytes]`)
  return { label, output: capped.text, notes: capped.truncation ? [`${label} truncated at ${maxBytes} bytes.`] : [] }
}

async function captureOptionalRawCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  label: string,
  argv: readonly string[],
  fallback: string,
  maxBytes: number
): Promise<CommandCapture> {
  const capture = await captureRawCommand(pi, ctx, label, argv, maxBytes)
  if (!capture.error) return capture
  return { label, output: fallback, notes: [`${label} unavailable: ${capture.error}`] }
}

function formatPreCollectedContext(title: string, parts: readonly string[]): string {
  return [`## ${title}`, ...parts.filter(Boolean)].join('\n\n')
}

function formatCapture(capture: CommandCapture): string {
  return [`### ${capture.label}`, indentBlock(capture.output.trim() || '<empty>')].join('\n\n')
}

function formatNotes(captures: readonly CommandCapture[]): string {
  const notes = captures.flatMap((capture) => capture.notes).filter(Boolean)
  if (notes.length === 0) return ''
  return ['### Capture notes', ...notes.map((note) => `- ${note}`)].join('\n')
}

function indentBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function suggestedPrBranchName(branchName: string): string {
  const base = branchName
    .replace(/^dev\/+/, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .replace(/^\/+|\/+$/g, '')
  return `pr/${base || 'changes'}`
}
