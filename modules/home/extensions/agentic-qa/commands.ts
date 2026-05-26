// ## COMMANDS ## //
// Registers localhost QA commands. Commands assemble mission/staged/freehand
// context, compile a QaRunSpec, and normally dispatch browser work to fresh Pi
// subagents; coordinator fallback can prompt the main agent when orchestration fails.

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { deferToAgentEnd } from '@pi/lib/agent-end'
import {
  applyCommandConfig,
  captureRestore,
  getCommandConfig,
  restoreCommandConfig
} from '../commands/config.ts'
import { buildQaArtifactPlan, type QaArtifactPlan } from './artifact-paths.ts'
import { writeAggregateQaReport } from './aggregate.ts'
import { runQaShardCoordinator } from './coordinator.ts'
import { getQaTargetUrl, isLocalhostQaTarget } from './config.ts'
import { fenced } from './markdown.ts'
import {
  collectStagedQaContext,
  discoverQaMissionSummaries,
  formatMissionList,
  loadQaMission,
  lookupQaMission,
  type QaMission,
  type QaMissionSummary,
  type StagedQaContext
} from './missions.ts'
import { deferQaRestoreUntilFinish, restoreQaConfigForRun } from './model-restore.ts'
import { QA_SYSTEM_PROMPT, renderQaEvidenceProtocolBullets } from './prompt.ts'
import {
  compileFreehandRunSpec,
  compileMissionRunSpec,
  compileStagedRunSpec,
  registerActiveRun,
  QA_EVIDENCE_TYPE_HELP,
  renderRunSpec,
  validateQaMissionSource,
  type QaRunSpec
} from './run-state.ts'
import {
  compileDirectShardPlan,
  createInitialQaShardRunState,
  runQaShardPlannerSubagent,
  writeQaShardPlan,
  writeQaShardRunState,
  type QaShardPlan,
  type QaShardRunState,
  type QaSourceCommandKind
} from './shards.ts'
import { ensureQaEnvironmentReady } from './setup.ts'

export function registerQaCommands(pi: ExtensionAPI): void {
  pi.registerCommand('qa', {
    description: 'Run a colocated QA mission by exact slug.',
    getArgumentCompletions: completeQaMissionArguments,
    handler: async (args, ctx) => runMissionQa(pi, ctx, args)
  })

  pi.registerCommand('qa:staged', {
    description: 'Run agentic QA against staged changes by inspecting the staged diff (does not use .qa.md files).',
    handler: async (args, ctx) => runStagedQa(pi, ctx, args)
  })

  pi.registerCommand('qa:freehand', {
    description: 'Run freehand agentic QA from a prompt.',
    handler: async (args, ctx) => runFreehandQa(pi, ctx, args)
  })

  pi.registerCommand('qa:new', {
    description: 'Create a colocated .qa.md QA mission from an optional natural-language prompt.',
    handler: async (args, ctx) => runNewQaMission(pi, ctx, args)
  })
}

async function runMissionQa(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  const request = parseMissionRequest(args)
  const mission = request.slug ? lookupRequestedMission(ctx, request.slug) : await pickMission(ctx)
  if (!mission) return

  const missionInvalid = validateQaMissionSource(mission.body)
  if (missionInvalid.length > 0) {
    ctx.ui.notify(`/qa ${mission.slug} is not executable:\n${missionInvalid.map((entry) => `- ${entry}`).join('\n')}`, 'error')
    return
  }

  const artifacts = buildQaArtifactPlan(mission.slug)
  const run = await prepareQaRun(pi, ctx, artifacts.runId)
  if (!run) return

  const spec = compileMissionRunSpec({ target: run.targetUrl, artifacts, mission })
  await dispatchPreparedQaShards(pi, ctx, spec, async () => {
    const shardPlan = compileDirectShardPlan(spec)
    const shardState = persistInitialShardState(ctx, shardPlan, 'qa')
    return {
      shardPlan,
      shardState,
      fallbackPrompt: buildMissionPrompt(spec, mission, request.extra, artifacts),
      label: `/qa ${mission.slug}`
    }
  })
}

async function runStagedQa(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  const artifacts = buildQaArtifactPlan('staged')
  const run = await prepareQaRun(pi, ctx, artifacts.runId)
  if (!run) return

  const staged = await collectStagedQaContext(pi, ctx)
  if (staged.error) {
    ctx.ui.notify(`/qa:staged could not read staged git context: ${staged.error}`, 'error')
    await restoreQaConfigForRun(pi, ctx, artifacts.runId)
    return
  }

  const spec = compileStagedRunSpec({
    target: run.targetUrl,
    artifacts,
    stagedFiles: staged.stagedFiles
  })
  await dispatchPreparedQaShards(pi, ctx, spec, async () => {
    const { shardPlan, shardState } = await runQaShardPlannerSubagent(pi, ctx, {
      spec,
      context: buildStagedPlannerContext(staged),
      sourceCommand: 'qa:staged',
      extra: args.trim()
    })
    return {
      shardPlan,
      shardState,
      fallbackPrompt: buildStagedPrompt(spec, staged, args.trim(), artifacts),
      label: '/qa:staged'
    }
  })
}

async function runFreehandQa(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  const prompt = args.trim()
  if (!prompt) {
    ctx.ui.notify('Usage: /qa:freehand <prompt>', 'warning')
    return
  }

  const artifacts = buildQaArtifactPlan('freehand')
  const run = await prepareQaRun(pi, ctx, artifacts.runId)
  if (!run) return

  const spec = compileFreehandRunSpec({ target: run.targetUrl, artifacts, prompt })
  await dispatchPreparedQaShards(pi, ctx, spec, async () => {
    const { shardPlan, shardState } = await runQaShardPlannerSubagent(pi, ctx, {
      spec,
      context: prompt,
      sourceCommand: 'qa:freehand'
    })
    return {
      shardPlan,
      shardState,
      fallbackPrompt: buildFreehandPrompt(spec, prompt, artifacts),
      label: '/qa:freehand'
    }
  })
}

async function runNewQaMission(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()

  if (!(await prepareQaAgent(pi, ctx, { kind: 'agent-end' }))) return

  pi.sendUserMessage(buildNewMissionPrompt(ctx.cwd, args.trim()), { deliverAs: 'followUp' })
}

function completeQaMissionArguments(prefix: string): { value: string; label: string; description: string }[] | null {
  const trimmed = prefix.trimStart()
  if (trimmed.includes(' ')) return null
  const needle = trimmed.toLowerCase()
  const items = discoverQaMissionSummaries(process.cwd())
    .filter((mission) => mission.slug.toLowerCase().startsWith(needle))
    .map((mission) => ({
      value: mission.slug,
      label: mission.slug,
      description: mission.title ? `${mission.title} (${mission.relativePath})` : mission.relativePath
    }))
  return items.length > 0 ? items : null
}

function parseMissionRequest(args: string): { slug: string; extra: string } {
  const trimmed = args.trim()
  if (!trimmed) return { slug: '', extra: '' }
  const [slug, ...extra] = trimmed.split(/\s+/)
  return { slug, extra: extra.join(' ').trim() }
}

function lookupRequestedMission(ctx: ExtensionCommandContext, slug: string): QaMission | undefined {
  const lookup = lookupQaMission(ctx.cwd, slug)
  if (lookup.kind === 'missing') {
    ctx.ui.notify(`Unknown QA mission '${slug}'.\n\nAvailable missions:\n${formatMissionList(lookup.available)}`, 'warning')
    return undefined
  }
  if (lookup.kind === 'ambiguous') {
    ctx.ui.notify(`Ambiguous QA mission '${slug}'.\n\nMatches:\n${formatMissionList(lookup.matches)}`, 'error')
    return undefined
  }
  if (!lookup.mission) {
    ctx.ui.notify(`QA mission '${slug}' could not be loaded.`, 'error')
    return undefined
  }
  return lookup.mission
}

async function pickMission(ctx: ExtensionCommandContext): Promise<QaMission | undefined> {
  const missions = discoverQaMissionSummaries(ctx.cwd)
  if (missions.length === 0) {
    ctx.ui.notify('No .qa.md missions found. Create one with /qa:new <what to test>.', 'warning')
    return undefined
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(`Usage: /qa <slug> [extra instructions]\n\nAvailable missions:\n${formatMissionList(missions)}`, 'warning')
    return undefined
  }

  const labels = missions.map(missionPickerLabel)
  const selected = await ctx.ui.select('Pick QA mission', labels)
  if (!selected) return undefined
  const summary = missions[labels.indexOf(selected)]
  return summary ? loadQaMission(ctx.cwd, summary) : undefined
}

function missionPickerLabel(mission: QaMissionSummary): string {
  return `${mission.slug}${mission.title ? ` — ${mission.title}` : ''} (${mission.relativePath})`
}

async function prepareQaRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runId: string
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

  if (!(await prepareQaAgent(pi, ctx, { kind: 'qa-finish', runId }))) return undefined

  return { targetUrl }
}

function buildWorkerFallbackPrompt(prompt: string, error: string): string {
  return [
    'QA subagent orchestration failed before completing the run.',
    `Subagent error: ${error}`,
    'Fallback: complete this QA run in the main agent using the original QA payload below.',
    prompt
  ].join('\n\n')
}

async function dispatchPreparedQaShards(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  spec: QaRunSpec,
  prepare: () => Promise<{
    readonly shardPlan: QaShardPlan
    readonly shardState: QaShardRunState
    readonly fallbackPrompt: string
    readonly label: string
  }>
): Promise<void> {
  let handedToCoordinator = false
  try {
    const input = await prepare()
    await ensureQaEnvironmentReady(pi, ctx, spec, input.label)
    handedToCoordinator = true
    await coordinateQaShards(pi, ctx, { spec, ...input })
  } finally {
    if (!handedToCoordinator) await restoreQaConfigForRun(pi, ctx, spec.runId)
  }
}

async function coordinateQaShards(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: {
    readonly spec: QaRunSpec
    readonly shardPlan: QaShardPlan
    readonly shardState: QaShardRunState
    readonly fallbackPrompt: string
    readonly label: string
  }
): Promise<void> {
  let handedToMainAgent = false
  try {
    ctx.ui.notify(`${input.label}: launching ${input.shardPlan.shards.length} QA shard(s).`, 'info')
    const result = await runQaShardCoordinator(pi, ctx, {
      parentSpec: input.spec,
      plan: input.shardPlan,
      state: input.shardState
    })
    const aggregate = await writeAggregateQaReport(ctx.cwd, {
      parentSpec: input.spec,
      shardState: result.state,
      shardPlan: input.shardPlan
    })
    const total = result.state.shards.length
    const message = `${input.label}: QA shards complete (${result.completed}/${total}; ${result.blocked} blocked). Parent report: ${aggregate.finish.status}.`
    ctx.ui.notify(message, result.blocked > 0 || aggregate.finish.status !== 'pass' ? 'warning' : 'info')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    registerActiveRun(input.spec)
    handedToMainAgent = true
    ctx.ui.notify(`${input.label}: QA shard coordinator failed; handing fallback to main agent. ${message}`, 'error')
    pi.sendUserMessage(buildWorkerFallbackPrompt(input.fallbackPrompt, message), { deliverAs: 'followUp' })
  } finally {
    if (!handedToMainAgent) await restoreQaConfigForRun(pi, ctx, input.spec.runId)
  }
}

function persistInitialShardState(
  ctx: ExtensionCommandContext,
  plan: QaShardPlan,
  sourceCommand: QaSourceCommandKind
): QaShardRunState {
  const state = createInitialQaShardRunState(plan, sourceCommand)
  writeQaShardPlan(ctx.cwd, plan)
  writeQaShardRunState(ctx.cwd, state)
  return state
}

type QaRestoreMode =
  | { readonly kind: 'agent-end' }
  | { readonly kind: 'qa-finish'; readonly runId: string }

async function prepareQaAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext, restoreMode: QaRestoreMode): Promise<boolean> {
  const config = getCommandConfig('qa')
  const shouldRestore = Boolean(config.model || config.thinking)
  const restore = shouldRestore ? captureRestore(pi, ctx, 'qa') : undefined
  if (!(await applyCommandConfig(pi, ctx, 'qa', config))) return false

  if (restore) {
    if (restoreMode.kind === 'qa-finish') {
      deferQaRestoreUntilFinish(pi, restoreMode.runId, restore)
    } else {
      await deferToAgentEnd(pi, async (endCtx) => {
        await restoreCommandConfig(pi, restore)
        endCtx.ui.notify('/qa config restored', 'info')
      })
    }
  }

  return true
}

function buildMissionPrompt(spec: QaRunSpec, mission: QaMission, extra: string, artifacts: QaArtifactPlan): string {
  return [
    QA_SYSTEM_PROMPT,
    qaModeHeader(spec.mode, spec.target),
    renderRunSpec(spec),
    'Mission instructions:',
    mission.body || '<empty mission body>',
    extra ? `Additional user instructions:\n${extra}` : undefined,
    qaShellNote(artifacts)
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildStagedPlannerContext(staged: StagedQaContext): string {
  return [
    `Staged files:\n${staged.stagedFiles.length ? staged.stagedFiles.map((file) => `- ${file}`).join('\n') : '- none'}`,
    'Staged diff:',
    fenced('diff', staged.stagedDiff?.trim() || '<no staged diff>')
  ].join('\n\n')
}

function buildStagedPrompt(spec: QaRunSpec, staged: StagedQaContext, extra: string, artifacts: QaArtifactPlan): string {
  return [
    QA_SYSTEM_PROMPT,
    qaModeHeader(spec.mode, spec.target),
    renderRunSpec(spec),
    `Staged files:\n${staged.stagedFiles.length ? staged.stagedFiles.map((file) => `- ${file}`).join('\n') : '- none'}`,
    'Staged diff (build the QA plan from this; do not pull in any colocated .qa.md mission):',
    fenced('diff', staged.stagedDiff?.trim() || '<no staged diff>'),
    extra ? `Additional user instructions:\n${extra}` : undefined,
    qaShellNote(artifacts)
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildFreehandPrompt(spec: QaRunSpec, prompt: string, artifacts: QaArtifactPlan): string {
  return [
    QA_SYSTEM_PROMPT,
    qaModeHeader(spec.mode, spec.target),
    renderRunSpec(spec),
    `Freehand prompt:\n${prompt}`,
    qaShellNote(artifacts)
  ].join('\n\n')
}

function buildNewMissionPrompt(cwd: string, prompt: string): string {
  return [
    'You are helping Toph create a colocated agentic QA mission file.',
    `Workspace: ${cwd}`,
    prompt ? `Creation prompt:\n${prompt}` : 'Creation prompt: <missing — collect it with ask_user before planning>',
    'Goal: create one useful `.qa.md` file that future `/qa` runs can execute. (/qa:staged does not consume .qa.md; it works from staged diffs.)',
    'Rules:',
    '- Treat `/qa:new` arguments as the initial natural-language prompt. Do not treat them as a slug, path grammar, or selection list, and do not ask Toph to restate them.',
    '- If the creation prompt is missing, first ask what QA mission to create using ask_user. The answer may be entirely freeform text; do not force a menu choice.',
    '- When using ask_user for missing prompt details or follow-up questions, always pass `allowFreeform: true` and `allowComment: true` so Toph can add context or answer something else in text.',
    '- If you offer options in ask_user, make them shortcuts only. Accept any freeform/comment text as valid instructions, even when it does not match an option.',
    '- Ask one focused question per ask_user call. Start with the most blocking unknown: feature/flow, expected behavior, setup, success/failure signals, or required evidence.',
    '- If enough information is present, inspect the project and choose the best colocated path.',
    '- Do not ask the user to choose a slug. The mission slug will default to the filename.',
    '- Name the file after the feature or flow, for example `login.qa.md`, and place it near the relevant route, component, or feature code.',
    '- Call qa_mission_create to create the file. If it rejects, fix the fields from the tool error and resubmit; do not research the tool schema.',
    '- Do not use Write/Edit for `.qa.md` mission files.',
    '- qa_mission_create renders the canonical Markdown DSL so /qa can compile concrete scenarios and required evidence.',
    '- Every scenario needs nonempty Given, When, Then, Checks, and Evidence required sections.',
    `- Evidence types: ${QA_EVIDENCE_TYPE_HELP}`,
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
        'Scenario: <short title>',
        'Given:',
        '- <starting state>',
        'When:',
        '- <browser action>',
        'Then:',
        '- <observable outcome>',
        'Checks:',
        '- <pass condition>',
        'Evidence required:',
        '- screenshot: <what to capture>',
        '- console: <expected absence/presence>',
        '',
        'Out of scope:',
        '- <flows explicitly skipped>',
        '',
        'Tags: smoke, regression'
      ].join('\n')
    )
  ].join('\n\n')
}

function qaModeHeader(mode: QaRunSpec['mode'], targetUrl: string): string {
  return `QA mode: ${mode}\nTarget URL: ${targetUrl}`
}

function qaShellNote(artifacts: QaArtifactPlan): string {
  return [
    'Do not claim browser pass/fail without browser evidence.',
    `Use runId ${artifacts.runId} for qa_plan, qa_step, and qa_finish.`,
    `QA artifacts for this run belong under ${artifacts.relativeRunDir}/. Pi will write report.json and report.md there when qa_finish is called.`,
    renderQaEvidenceProtocolBullets()
  ].join('\n')
}

