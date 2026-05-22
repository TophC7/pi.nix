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
import { buildQaArtifactPlan, type QaArtifactPlan } from './artifact-paths.ts'
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

  pi.registerCommand('qa:new', {
    description: 'Create a colocated .qa.md QA mission from a prompt.',
    handler: async (args, ctx) => runNewQaMission(pi, ctx, args)
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
  pi.sendUserMessage(buildMissionPrompt(run.targetUrl, mission, request.extra, buildQaArtifactPlan(mission.slug)), {
    deliverAs: 'followUp'
  })
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
  pi.sendUserMessage(buildStagedPrompt(run.targetUrl, selection, args.trim(), buildQaArtifactPlan(stagedArtifactSlug(selection))), {
    deliverAs: 'followUp'
  })
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

  pi.sendUserMessage(buildFreehandPrompt(run.targetUrl, prompt, buildQaArtifactPlan('freehand')), { deliverAs: 'followUp' })
}

async function runNewQaMission(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  if (!(await prepareQaAgent(pi, ctx))) return

  pi.sendUserMessage(buildNewMissionPrompt(ctx.cwd, args.trim()), { deliverAs: 'followUp' })
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

  if (!(await prepareQaAgent(pi, ctx))) return undefined

  return { targetUrl }
}

async function prepareQaAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
  const config = getCommandConfig('qa')
  const shouldRestore = Boolean(config.model || config.thinking)
  const restore = shouldRestore ? captureRestore(pi, ctx, 'qa') : undefined
  if (!(await applyCommandConfig(pi, ctx, 'qa', config))) return false

  if (restore) {
    await deferToAgentEnd(pi, async (endCtx) => {
      await restoreCommandConfig(pi, restore)
      endCtx.ui.notify('/qa config restored', 'info')
    })
  }

  return true
}

function buildMissionPrompt(targetUrl: string, mission: QaMission, extra: string, artifacts: QaArtifactPlan): string {
  return [
    QA_SYSTEM_PROMPT,
    qaModeHeader('mission', targetUrl),
    `Mission slug: ${mission.slug}`,
    `Mission file: ${mission.relativePath}`,
    mission.title ? `Mission title: ${mission.title}` : undefined,
    'Mission instructions:',
    mission.body || '<empty mission body>',
    extra ? `Additional user instructions:\n${extra}` : undefined,
    qaShellNote(artifacts)
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildStagedPrompt(
  targetUrl: string,
  selection: StagedMissionSelection,
  extra: string,
  artifacts: QaArtifactPlan
): string {
  const missionContext = selection.missions.length
    ? ['Nearest colocated missions:', ...selection.missions.map(renderMissionContext)].join('\n\n')
    : ['No nearest .qa.md mission found for staged files.', 'Use the staged diff to infer a focused QA plan.', fenced('diff', selection.stagedDiff ?? '<no staged diff>')].join('\n\n')

  return [
    QA_SYSTEM_PROMPT,
    qaModeHeader('staged', targetUrl),
    `Staged files:\n${selection.stagedFiles.length ? selection.stagedFiles.map((file) => `- ${file}`).join('\n') : '- none'}`,
    missionContext,
    extra ? `Additional user instructions:\n${extra}` : undefined,
    qaShellNote(artifacts)
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildFreehandPrompt(targetUrl: string, prompt: string, artifacts: QaArtifactPlan): string {
  return [QA_SYSTEM_PROMPT, qaModeHeader('freehand', targetUrl), `Freehand prompt:\n${prompt}`, qaShellNote(artifacts)].join('\n\n')
}

function buildNewMissionPrompt(cwd: string, prompt: string): string {
  return [
    'You are helping Toph create a colocated agentic QA mission file.',
    `Workspace: ${cwd}`,
    prompt ? `Creation prompt:\n${prompt}` : 'Creation prompt: <missing>',
    'Goal: create one useful `.qa.md` file that future `/qa` and `/qa:staged` runs can execute.',
    'Rules:',
    '- Treat `/qa:new` arguments as a plain natural-language prompt, not a slug, path grammar, or selection list.',
    '- If the prompt lacks enough information to choose the feature, flow, or expected behavior, ask concise follow-up questions before writing.',
    '- If enough information is present, inspect the project, choose the best colocated location, and create the file.',
    '- Do not ask the user to choose a slug. Prefer no frontmatter; the mission slug will default to the filename.',
    '- Name the file after the feature or flow, for example `login.qa.md`, and place it near the relevant route, component, or feature code.',
    '- Write browser-observable mission instructions: target flow, setup/state assumptions, steps, assertions, failure signals, and safety notes.',
    '- Use synthetic/local data only. Do not include credentials, tokens, PHI, cookies, passwords, or real user data.',
    '- Do not run QA now; this command creates the mission only.',
    'Recommended file shape:',
    fenced(
      'md',
      [
        '# <Feature or flow> QA',
        '',
        'Purpose: <what confidence this mission should provide>.',
        '',
        'Setup:',
        '- <local preconditions or none>',
        '',
        'Steps:',
        '1. <browser action>',
        '2. <browser action>',
        '',
        'Checks:',
        '- <observable pass condition>',
        '- <console/network/accessibility condition>',
        '',
        'Safety notes:',
        '- Use synthetic local data only.'
      ].join('\n')
    )
  ].join('\n\n')
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

function qaShellNote(artifacts: QaArtifactPlan): string {
  return [
    'Do not claim browser pass/fail without browser evidence.',
    'Use qa_report for the final report; it writes local artifacts only when safety gates pass.',
    `Set qa_report.slug to ${artifacts.slug} and qa_report.runId to ${artifacts.runId}.`,
    `QA artifacts for this run belong under ${artifacts.relativeRunDir}/.`,
    `Create ${artifacts.relativeArtifactDir}/ before screenshots if the screenshot tool needs the directory to exist.`,
    `Save screenshot MCP artifacts under ${artifacts.relativeArtifactDir}/ when the screenshot tool supports paths. Use filenames like E1.png, E2.png.`,
    `For every screenshot evidence item, include artifactPaths with the local screenshot path, for example ${artifacts.relativeArtifactDir}/E1.png.`,
    'The final report.md will inline bundled screenshots next to their Evidence entries.'
  ].join('\n')
}

function stagedArtifactSlug(selection: StagedMissionSelection): string {
  if (selection.missions.length === 1 && selection.missions[0]?.slug) return selection.missions[0].slug
  return 'staged'
}

function fenced(language: string, value: string): string {
  return `\`\`\`${language}\n${value}\n\`\`\``
}
