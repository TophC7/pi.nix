// ## COMMANDS ## //
// Registers localhost QA commands. Commands assemble mission/staged/freehand
// context and hand browser-evidence-focused work to the active agent.

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { deferToAgentEnd } from '@pi/lib/agent-end'
import {
  applyCommandConfig,
  captureRestore,
  getCommandConfig,
  restoreCommandConfig
} from '../commands/config'
import { getQaTargetUrl, isLocalhostQaTarget } from './config.ts'
import {
  formatMissionList,
  lookupQaMission,
  selectStagedQaMissions,
  type QaMission,
  type StagedMissionSelection
} from './missions.ts'
import { QA_SYSTEM_PROMPT } from './prompt.ts'

type QaMode = 'mission' | 'staged' | 'freehand'

export function registerQaCommands(pi: ExtensionAPI): void {
  pi.registerCommand('qa', {
    description: 'Run a colocated QA mission by exact slug.',
    handler: async (args, ctx) => runMissionQa(pi, ctx, args)
  })

  pi.registerCommand('qa:staged', {
    description: 'Run agentic QA against staged changes, using nearest colocated missions when present.',
    handler: async (args, ctx) => runStagedQa(pi, ctx, args)
  })

  pi.registerCommand('qa:freehand', {
    description: 'Run freehand agentic QA from a prompt.',
    handler: async (args, ctx) => runFreehandQa(pi, ctx, args)
  })
}

async function runMissionQa(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  const run = await prepareQaRun(pi, ctx)
  if (!run) return

  const request = parseMissionRequest(args)
  if (!request.slug) {
    const lookup = lookupQaMission(ctx.cwd, '')
    ctx.ui.notify(`Usage: /qa <slug> [extra instructions]\n\nAvailable missions:\n${formatMissionList(lookup.available)}`, 'warning')
    return
  }

  const lookup = lookupQaMission(ctx.cwd, request.slug)
  if (lookup.kind === 'missing') {
    ctx.ui.notify(`Unknown QA mission '${request.slug}'.\n\nAvailable missions:\n${formatMissionList(lookup.available)}`, 'warning')
    return
  }
  if (lookup.kind === 'ambiguous') {
    ctx.ui.notify(`Ambiguous QA mission '${request.slug}'.\n\nMatches:\n${formatMissionList(lookup.matches)}`, 'error')
    return
  }

  const mission = lookup.mission
  if (!mission) {
    ctx.ui.notify(`QA mission '${request.slug}' could not be loaded.`, 'error')
    return
  }
  pi.sendUserMessage(buildMissionPrompt(run.targetUrl, mission, request.extra), { deliverAs: 'followUp' })
}

async function runStagedQa(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  const run = await prepareQaRun(pi, ctx)
  if (!run) return

  const selection = await selectStagedQaMissions(pi, ctx)
  if (selection.error) {
    ctx.ui.notify(`/qa:staged could not read staged git context: ${selection.error}`, 'error')
    return
  }
  pi.sendUserMessage(buildStagedPrompt(run.targetUrl, selection, args.trim()), { deliverAs: 'followUp' })
}

async function runFreehandQa(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  const run = await prepareQaRun(pi, ctx)
  if (!run) return

  const prompt = args.trim()
  if (!prompt) {
    ctx.ui.notify('Usage: /qa:freehand <prompt>', 'warning')
    return
  }

  pi.sendUserMessage(buildFreehandPrompt(run.targetUrl, prompt), { deliverAs: 'followUp' })
}

function parseMissionRequest(args: string): { slug: string; extra: string } {
  const trimmed = args.trim()
  if (!trimmed) return { slug: '', extra: '' }
  const [slug, ...extra] = trimmed.split(/\s+/)
  return { slug, extra: extra.join(' ').trim() }
}

async function prepareQaRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<{ readonly targetUrl: string } | undefined> {
  const targetUrl = getQaTargetUrl()
  if (!targetUrl) {
    ctx.ui.notify('QA target URL is not configured. Run /config and set the /qa target row.', 'error')
    return undefined
  }
  if (!isLocalhostQaTarget(targetUrl)) {
    ctx.ui.notify(`QA target must be a localhost http(s) URL: ${targetUrl}`, 'error')
    return undefined
  }

  const config = getCommandConfig('qa')
  const shouldRestore = Boolean(config.model || config.thinking)
  const restore = shouldRestore ? captureRestore(pi, ctx, 'qa') : undefined
  if (!(await applyCommandConfig(pi, ctx, 'qa', config))) return undefined

  if (restore) {
    await deferToAgentEnd(pi, async (endCtx) => {
      await restoreCommandConfig(pi, restore)
      endCtx.ui.notify('/qa config restored', 'info')
    })
  }

  return { targetUrl }
}

function buildMissionPrompt(targetUrl: string, mission: QaMission, extra: string): string {
  return [
    QA_SYSTEM_PROMPT,
    qaModeHeader('mission', targetUrl),
    `Mission slug: ${mission.slug}`,
    `Mission file: ${mission.relativePath}`,
    mission.title ? `Mission title: ${mission.title}` : undefined,
    'Mission instructions:',
    mission.body || '<empty mission body>',
    extra ? `Additional user instructions:\n${extra}` : undefined,
    qaShellNote()
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildStagedPrompt(targetUrl: string, selection: StagedMissionSelection, extra: string): string {
  const missionContext = selection.missions.length
    ? ['Nearest colocated missions:', ...selection.missions.map(renderMissionContext)].join('\n\n')
    : ['No nearest .qa.md mission found for staged files.', 'Use the staged diff to infer a focused QA plan.', fenced('diff', selection.stagedDiff ?? '<no staged diff>')].join('\n\n')

  return [
    QA_SYSTEM_PROMPT,
    qaModeHeader('staged', targetUrl),
    `Staged files:\n${selection.stagedFiles.length ? selection.stagedFiles.map((file) => `- ${file}`).join('\n') : '- none'}`,
    missionContext,
    extra ? `Additional user instructions:\n${extra}` : undefined,
    qaShellNote()
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildFreehandPrompt(targetUrl: string, prompt: string): string {
  return [QA_SYSTEM_PROMPT, qaModeHeader('freehand', targetUrl), `Freehand prompt:\n${prompt}`, qaShellNote()].join('\n\n')
}

function renderMissionContext(mission: QaMission): string {
  return [
    `Mission slug: ${mission.slug}`,
    `Mission file: ${mission.relativePath}`,
    mission.title ? `Mission title: ${mission.title}` : undefined,
    'Mission instructions:',
    mission.body || '<empty mission body>'
  ]
    .filter(Boolean)
    .join('\n')
}

function qaModeHeader(mode: QaMode, targetUrl: string): string {
  return `QA mode: ${mode}\nTarget URL: ${targetUrl}`
}

function qaShellNote(): string {
  return 'Do not claim browser pass/fail without browser evidence. Use qa_report for the final report; it writes local artifacts only when safety gates pass.'
}

function fenced(language: string, value: string): string {
  return `\`\`\`${language}\n${value}\n\`\`\``
}
