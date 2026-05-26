// ## TOOLS ## //
// LLM-callable QA helpers. The state machine is:
//   qa_plan -> (Playwright direct tools, captured passively) -> qa_step+ -> qa_finish
// qa_finish writes the deterministic report.json + generated report.md.

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import { singleLine, truncate } from '../pi-lib/subagents/render-helpers.ts'
import { createQaMissionFile, type QaMissionCreateInput } from './mission-create.ts'
import { writeQaFinishArtifacts } from './artifacts.ts'
import { restoreQaConfigForRun } from './model-restore.ts'
import { clearPendingCapturesForRun } from './playwright-capture.ts'
import { hydrateQaShardWorkerRun, submitQaShardPlanToolInput, type QaShardPlanToolInput } from './shards.ts'
import {
  QA_EVIDENCE_TYPE_HELP,
  QA_EVIDENCE_TYPE_VALUES,
  bindActiveRunContext,
  clearActiveRun,
  registerActiveRun,
  computeQaFinish,
  findMissingRequiredEvidence,
  getActiveRun,
  getEvidence,
  recordAcceptedPlan,
  recordQaStep,
  validateQaPlan,
  validateQaStep,
  type AcceptedQaPlan,
  type QaEvidenceRecord,
  type QaFinishInput,
  type QaFinishResult,
  type QaPlanInput,
  type QaStepInput,
  type QaStepRecord
} from './run-state.ts'

const EvidenceType = Type.Union(
  QA_EVIDENCE_TYPE_VALUES.map((value) => Type.Literal(value)),
  { description: QA_EVIDENCE_TYPE_HELP }
)

const PlanEvidence = Type.Object({
  type: EvidenceType,
  purpose: Type.String({ description: 'What this evidence will confirm or capture.' }),
  scenarioId: Type.Optional(Type.String())
})

const PlanScenario = Type.Object({
  scenarioId: Type.String({ description: 'Run-spec scenario id this plan entry covers, for example S1.' }),
  title: Type.String(),
  plannedSteps: Type.Array(Type.String({ description: 'Concrete browser-observable step. Vague steps are rejected.' })),
  evidenceToCollect: Type.Array(PlanEvidence)
})

const PlanOutOfScope = Type.Object({
  scenarioId: Type.String(),
  reason: Type.String({ description: 'Why this run-spec scenario will not be exercised in this run.' })
})

const StepStatus = Type.Union([
  Type.Literal('pass'),
  Type.Literal('fail'),
  Type.Literal('inconclusive'),
  Type.Literal('skipped')
])

const FinishBug = Type.Object({
  claim: Type.String(),
  evidenceIds: Type.Array(Type.String())
})

const ShardPlanEvidence = Type.Object({
  type: EvidenceType,
  purpose: Type.String(),
  scenarioId: Type.Optional(Type.String())
})

const ShardPlanScenario = Type.Object({
  scenarioId: Type.Optional(Type.String()),
  title: Type.String(),
  given: Type.Array(Type.String()),
  when: Type.Array(Type.String()),
  then: Type.Array(Type.String()),
  checks: Type.Array(Type.String()),
  requiredEvidence: Type.Array(ShardPlanEvidence),
  safetyNotes: Type.Optional(Type.Array(Type.String()))
})

const MissionCreateEvidence = Type.Object({
  type: EvidenceType,
  purpose: Type.String()
})

const MissionCreateScenario = Type.Object({
  title: Type.String(),
  given: Type.Array(Type.String()),
  when: Type.Array(Type.String()),
  then: Type.Array(Type.String()),
  checks: Type.Array(Type.String()),
  requiredEvidence: Type.Array(MissionCreateEvidence)
})

export function registerQaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'qa_shard_plan',
    label: 'QA Shard Plan',
    description:
      'Submit a typed transient shard plan for /qa:staged or /qa:freehand. Pi validates, normalizes, and writes shards.json plus shard-state.json; do not write JSON files yourself.',
    promptSnippet:
      `Planner agents call qa_shard_plan with runId and atomic shards. Every shard needs nonempty given/when/then/checks and requiredEvidence. ${QA_EVIDENCE_TYPE_HELP}`,
    parameters: Type.Object({
      runId: Type.String(),
      shards: Type.Array(ShardPlanScenario),
      safetyNotes: Type.Optional(Type.Array(Type.String()))
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => executeQaShardPlan(params, ctx.cwd)
  })

  pi.registerTool({
    name: 'qa_mission_create',
    label: 'QA Mission Create',
    description:
      'Create a canonical colocated .qa.md mission from typed scenario fields. Pi renders the Markdown DSL so future /qa runs compile deterministically.',
    promptSnippet:
      `Use qa_mission_create for /qa:new instead of Write/Edit. Provide a workspace-relative .qa.md path and complete Scenario/Given/When/Then/Checks/Evidence fields. ${QA_EVIDENCE_TYPE_HELP}`,
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative path ending in .qa.md.' }),
      title: Type.String(),
      purpose: Type.String(),
      setup: Type.Optional(Type.Array(Type.String())),
      scenarios: Type.Array(MissionCreateScenario),
      outOfScope: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String()))
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => executeQaMissionCreate(params, ctx.cwd)
  })

  pi.registerTool({
    name: 'qa_plan',
    label: 'QA Plan',
    description:
      'Submit the QA execution plan for the active run. Pi validates the plan against the active QaRunSpec (target, scenario coverage, evidence intent, safety). Until a plan is accepted, downstream browser pass/fail claims will be forced inconclusive.',
    promptSnippet:
      'Call qa_plan first, before any browser pass/fail claim. Pass the runId from the command prompt, the localhost target, and a planned step list + evidenceToCollect for every run-spec scenario you intend to exercise. Mark untouched scenarios via outOfScope with a reason.',
    parameters: Type.Object({
      runId: Type.String(),
      target: Type.String({ description: 'Localhost target URL for this run.' }),
      scenarios: Type.Array(PlanScenario),
      outOfScope: Type.Optional(Type.Array(PlanOutOfScope)),
      safetyNotes: Type.Optional(Type.Array(Type.String()))
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => executeQaPlan(params, ctx)
  })

  pi.registerTool({
    name: 'qa_step',
    label: 'QA Step',
    description:
      'Record one structured QA assertion against the active run. Pass and fail steps require expected, observed, and at least one evidence id captured during this run. Invalid steps are rejected.',
    promptSnippet:
      'Use qa_step after each meaningful browser assertion. Cite E# evidence ids that Pi assigned. If rejected or unsure, call qa_evidence_list and retry before qa_finish. Title describes the assertion, not the click.',
    parameters: Type.Object({
      runId: Type.String(),
      scenarioId: Type.String(),
      title: Type.String(),
      status: StepStatus,
      expected: Type.Array(Type.String()),
      observed: Type.Array(Type.String()),
      evidenceIds: Type.Array(Type.String()),
      bugs: Type.Optional(Type.Array(Type.String()))
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => executeQaStep(params, ctx)
  })

  pi.registerTool({
    name: 'qa_evidence_list',
    label: 'QA Evidence List',
    description:
      'List QA evidence ids captured so far for an active run, plus any still-missing required evidence for a scenario. Use when choosing evidenceIds for qa_step or repairing rejected citations.',
    promptSnippet:
      'Use qa_evidence_list when you need current QA evidence ids. Cite E# ids in qa_step; do not cite Playwright artifact paths.',
    parameters: Type.Object({
      runId: Type.String(),
      scenarioId: Type.Optional(Type.String({ description: 'Optional scenario id, for example S1, to show scenario-specific missing evidence.' }))
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => executeQaEvidenceList(params, ctx)
  })

  pi.registerTool({
    name: 'qa_finish',
    label: 'QA Finish',
    description:
      'Finish the active QA run. Pi computes the final status from accepted plan, captured evidence, recorded steps, bugs, coverage, and safety blockers, then writes report.json and generated report.md under the run directory.',
    promptSnippet:
      'Call qa_finish once after all qa_step calls. Pi computes pass / fail / inconclusive and writes the report; do not author the report yourself.',
    parameters: Type.Object({
      runId: Type.String(),
      summary: Type.String(),
      bugs: Type.Optional(Type.Array(FinishBug)),
      safetyNotes: Type.Optional(Type.Array(Type.String())),
      nextSteps: Type.Optional(Type.Array(Type.String()))
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => executeQaFinish(params, ctx.cwd, pi, ctx)
  })
}

async function executeQaShardPlan(params: QaShardPlanToolInput, cwd: string) {
  const result = submitQaShardPlanToolInput(cwd, params)
  return {
    content: [{ type: 'text' as const, text: renderShardPlanResult(result) }],
    details: result,
    isError: !result.accepted
  }
}

async function executeQaMissionCreate(params: QaMissionCreateInput, cwd: string) {
  const result = await createQaMissionFile(cwd, params)
  return {
    content: [{ type: 'text' as const, text: renderMissionCreateResult(result) }],
    details: result,
    isError: !result.created
  }
}

function getOrHydrateQaRun(runId: string, cwd: string | undefined) {
  let active = getActiveRun(runId)
  if (!active && cwd) {
    const hydrated = hydrateQaShardWorkerRun(cwd, runId)
    if (hydrated) {
      registerActiveRun(hydrated)
      active = getActiveRun(runId)
    }
  }
  return active
}

async function executeQaPlan(params: QaPlanInput, ctx?: ExtensionContext) {
  const active = getOrHydrateQaRun(params.runId, ctx?.cwd)
  if (!active) {
    const text = `qa_plan rejected: no active QA run with runId ${params.runId}. Start a /qa, /qa:staged, or /qa:freehand command first, then submit the plan using the runId from the command prompt.`
    return {
      content: [{ type: 'text' as const, text }],
      details: { accepted: false, runId: params.runId, acceptedScenarioIds: [], missing: ['no active QA run'], invalid: [] },
      isError: true
    }
  }

  bindActiveRunContext(ctx, params.runId)

  const result = validateQaPlan(active.spec, params)
  if (result.accepted) {
    const plan: AcceptedQaPlan = {
      runId: params.runId,
      target: params.target,
      acceptedScenarioIds: result.acceptedScenarioIds,
      scenarios: params.scenarios,
      outOfScope: params.outOfScope ?? [],
      safetyNotes: params.safetyNotes ?? [],
      acceptedAt: new Date().toISOString()
    }
    recordAcceptedPlan(params.runId, plan)
  }

  return {
    content: [{ type: 'text' as const, text: renderPlanResult(result) }],
    details: result,
    isError: !result.accepted
  }
}

async function executeQaStep(params: QaStepInput, ctx?: ExtensionContext) {
  const active = getOrHydrateQaRun(params.runId, ctx?.cwd)
  if (!active) {
    return {
      content: [{ type: 'text' as const, text: `qa_step rejected: no active QA run with runId ${params.runId}.` }],
      details: { accepted: false, invalid: ['no active QA run'] },
      isError: true
    }
  }
  bindActiveRunContext(ctx, params.runId)

  const result = validateQaStep(active, params)
  if (!result.accepted) {
    const evidence = getEvidence(params.runId)
    return {
      content: [{ type: 'text' as const, text: renderStepRejection(params, result.invalid, evidence) }],
      details: { ...result, evidence: summarizeEvidenceDetails(evidence) },
      isError: true
    }
  }
  const record = recordQaStep(active, params)
  const missingEvidence = findMissingRequiredEvidence(active, { scenarioId: record.scenarioId })
  return {
    content: [{ type: 'text' as const, text: renderStepAccepted(record, missingEvidence.map((gap) => gap.message), active.evidence) }],
    details: { accepted: true, record, missingEvidence },
    isError: false
  }
}

async function executeQaEvidenceList(params: { readonly runId: string; readonly scenarioId?: string }, ctx?: ExtensionContext) {
  const active = getOrHydrateQaRun(params.runId, ctx?.cwd)
  if (!active) {
    return {
      content: [{ type: 'text' as const, text: `qa_evidence_list rejected: no active QA run with runId ${params.runId}.` }],
      details: { accepted: false, invalid: ['no active QA run'] },
      isError: true
    }
  }
  bindActiveRunContext(ctx, params.runId)
  const evidence = getEvidence(params.runId)
  const missingEvidence = findMissingRequiredEvidence(active, { scenarioId: params.scenarioId })
  return {
    content: [{ type: 'text' as const, text: renderEvidenceList(params.runId, params.scenarioId, evidence, missingEvidence.map((gap) => gap.message)) }],
    details: { accepted: true, evidence: summarizeEvidenceDetails(evidence), missingEvidence },
    isError: false
  }
}

async function executeQaFinish(params: QaFinishInput, cwd: string, pi: ExtensionAPI, ctx: Pick<ExtensionContext, 'ui'>) {
  let shouldCloseRun = true
  try {
    const active = getOrHydrateQaRun(params.runId, cwd)
    if (!active) {
      return {
        content: [{ type: 'text' as const, text: `qa_finish rejected: no active QA run with runId ${params.runId}.` }],
        details: { status: 'inconclusive', blockers: ['no active QA run'] },
        isError: true
      }
    }

    bindActiveRunContext(ctx, params.runId)

    const result = computeQaFinish(active, params)
    if (failedRunLacksScreenshot(result)) {
      shouldCloseRun = false
      return {
        content: [{ type: 'text' as const, text: renderFinishNeedsScreenshot(result, active.evidence) }],
        details: { ...result, evidence: summarizeEvidenceDetails(active.evidence), needsScreenshot: true },
        isError: true
      }
    }
    const artifacts = await writeQaFinishArtifacts(cwd, result)
    const text = `${renderFinishSummary(result)}\n${renderArtifactSummary(artifacts)}`
    return {
      content: [{ type: 'text' as const, text }],
      details: { ...result, artifacts },
      isError: result.status !== 'pass' || artifacts.blocked
    }
  } finally {
    if (shouldCloseRun) {
      clearPendingCapturesForRun(params.runId)
      clearActiveRun(params.runId)
      await restoreQaConfigForRun(pi, ctx, params.runId)
    }
  }
}

function renderShardPlanResult(result: ReturnType<typeof submitQaShardPlanToolInput>): string {
  if (result.accepted) {
    return [
      `qa_shard_plan: accepted`,
      `runId: ${result.runId}`,
      `shards: ${result.shardCount}`,
      `plan: ${result.planPath}`,
      `state: ${result.statePath}`
    ].join('\n')
  }
  return [`qa_shard_plan: rejected`, `runId: ${result.runId}`, 'Invalid:', ...result.invalid.map((entry) => `- ${entry}`)].join('\n')
}

function renderMissionCreateResult(result: Awaited<ReturnType<typeof createQaMissionFile>>): string {
  if (result.created) return `qa_mission_create: created\npath: ${result.path}`
  return ['qa_mission_create: rejected', 'Invalid:', ...result.invalid.map((entry) => `- ${entry}`)].join('\n')
}

function renderArtifactSummary(artifacts: Awaited<ReturnType<typeof writeQaFinishArtifacts>>): string {
  if (artifacts.written) {
    const lines = ['', 'Artifacts:', `- report: ${artifacts.reportPath}`, `- report.json: ${artifacts.reportJsonPath}`]
    if (artifacts.artifactDir) lines.push(`- artifacts: ${artifacts.artifactDir}`)
    return lines.join('\n')
  }
  if (artifacts.blocked) {
    return `\nArtifacts blocked:\n${artifacts.reasons.map((reason) => `- ${reason}`).join('\n')}`
  }
  return ''
}

function renderFinishSummary(result: QaFinishResult): string {
  const lines: string[] = []
  lines.push(`qa_finish: ${result.status}`)
  lines.push(`runId: ${result.runId}`)
  lines.push(`Summary: ${result.summary}`)
  if (result.failures.length) {
    lines.push('Failures:')
    for (const item of result.failures) lines.push(`- ${item}`)
  }
  if (result.blockers.length) {
    lines.push('Blockers:')
    for (const item of result.blockers) lines.push(`- ${item}`)
  }
  lines.push('Coverage:')
  for (const entry of result.coverage) lines.push(`- ${entry.scenarioId} ${entry.title} [${entry.status}]`)
  if (result.missingEvidence.length) {
    lines.push('Missing evidence:')
    for (const item of result.missingEvidence) lines.push(`- ${item}`)
  }
  return lines.join('\n')
}

function renderStepRejection(input: QaStepInput, invalid: readonly string[], evidence: readonly QaEvidenceRecord[]): string {
  const lines = ['qa_step rejected:', ...invalid.map((entry) => `- ${entry}`)]
  if (input.evidenceIds.some((id) => !/^E\d+$/i.test(id.trim()))) {
    lines.push('Evidence ids must be QA ids like E1, E2. Do not cite .playwright-mcp paths, screenshot filenames, or artifact paths.')
  }
  lines.push(...renderEvidenceCatalog(evidence))
  lines.push('Retry qa_step with valid E# evidenceIds before qa_finish.')
  return lines.join('\n')
}

function renderStepAccepted(record: QaStepRecord, missingEvidence: readonly string[], evidence: readonly QaEvidenceRecord[]): string {
  const lines = [`qa_step accepted: ${record.scenarioId} ${record.title} [${record.status}]`]
  if ((record.status === 'fail' || record.bugs.length > 0) && !hasScreenshotArtifact(evidence)) {
    lines.push('This fail/bug will require screenshot evidence before qa_finish. Call playwright_browser_take_screenshot, then cite that E# in qa_step or qa_finish bugs.')
  }
  if (missingEvidence.length > 0) {
    lines.push(`Scenario ${record.scenarioId} still missing required evidence:`)
    for (const item of missingEvidence) lines.push(`- ${item}`)
    lines.push('Capture or cite those evidence types before qa_finish to avoid inconclusive status.')
  }
  return lines.join('\n')
}

function failedRunLacksScreenshot(result: QaFinishResult): boolean {
  return result.blockers.some((blocker) => blocker === 'failed run lacks a screenshot evidence record with an artifact path')
}

function renderFinishNeedsScreenshot(result: QaFinishResult, evidence: readonly QaEvidenceRecord[]): string {
  return [
    'qa_finish rejected: failed run needs screenshot evidence before report finalization.',
    'Call playwright_browser_take_screenshot now, then retry qa_finish. Pi will append a QA evidence id and persist the image artifact.',
    ...renderEvidenceCatalog(evidence),
    'Current blockers:',
    ...result.blockers.map((blocker) => `- ${blocker}`)
  ].join('\n')
}

function renderEvidenceList(runId: string, scenarioId: string | undefined, evidence: readonly QaEvidenceRecord[], missingEvidence: readonly string[]): string {
  const lines = [`qa_evidence_list: ${runId}${scenarioId ? ` ${scenarioId}` : ''}`]
  lines.push(...renderEvidenceCatalog(evidence))
  if (missingEvidence.length > 0) {
    lines.push('Missing required evidence:')
    for (const item of missingEvidence) lines.push(`- ${item}`)
  } else {
    lines.push('Missing required evidence: none')
  }
  return lines.join('\n')
}

function renderEvidenceCatalog(evidence: readonly QaEvidenceRecord[]): string[] {
  if (evidence.length === 0) return ['Available evidence: none captured yet. Run Playwright direct tools first.']
  return ['Available evidence:', ...evidence.map((record) => `- ${formatEvidenceRecord(record)}`)]
}

function hasScreenshotArtifact(evidence: readonly QaEvidenceRecord[]): boolean {
  return evidence.some((record) => record.type === 'screenshot' && !record.isError && record.artifactPaths.length > 0)
}

function summarizeEvidenceDetails(evidence: readonly QaEvidenceRecord[]) {
  return evidence.map((record) => ({
    id: record.id,
    type: record.type,
    sourceTool: record.sourceTool,
    isError: record.isError,
    artifactPaths: [...record.artifactPaths]
  }))
}

function formatEvidenceRecord(record: QaEvidenceRecord): string {
  const parts = [`${record.id} ${record.type}`, `[${record.isError ? 'error' : 'ok'}]`, `source=${record.sourceTool}`]
  if (record.artifactPaths.length > 0) parts.push(`artifacts=${record.artifactPaths.join(',')}`)
  const input = truncate(singleLine(record.inputSummary ?? ''), 90)
  const summary = truncate(singleLine(record.summary ?? ''), 120)
  if (input) parts.push(`input=${input}`)
  if (summary) parts.push(`summary=${summary}`)
  return parts.join(' ')
}

function renderPlanResult(result: ReturnType<typeof validateQaPlan>): string {
  const lines: string[] = []
  lines.push(`qa_plan: ${result.accepted ? 'accepted' : 'rejected'}`)
  lines.push(`runId: ${result.runId}`)
  if (result.acceptedScenarioIds.length) lines.push(`Accepted scenarios: ${result.acceptedScenarioIds.join(', ')}`)
  if (result.missing.length) {
    lines.push('Missing:')
    for (const item of result.missing) lines.push(`- ${item}`)
  }
  if (result.invalid.length) {
    lines.push('Invalid:')
    for (const item of result.invalid) lines.push(`- ${item}`)
  }
  if (!result.accepted) lines.push('Resubmit qa_plan with corrections. Browser pass/fail claims without an accepted plan will be forced inconclusive.')
  return lines.join('\n')
}
