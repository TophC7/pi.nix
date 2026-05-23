// ## TOOLS ## //
// LLM-callable QA helpers. The state machine is:
//   qa_plan -> (Playwright direct tools, captured passively) -> qa_step+ -> qa_finish
// qa_finish writes the deterministic report.json + generated report.md.

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import { writeQaFinishArtifacts } from './artifacts.ts'
import { restoreQaConfigForRun } from './model-restore.ts'
import { clearPendingCapturesForRun } from './playwright-capture.ts'
import {
  clearActiveRun,
  computeQaFinish,
  getActiveRun,
  recordAcceptedPlan,
  recordQaStep,
  validateQaPlan,
  validateQaStep,
  type AcceptedQaPlan,
  type QaFinishInput,
  type QaFinishResult,
  type QaPlanInput,
  type QaStepInput
} from './run-state.ts'

const EvidenceType = Type.Union([
  Type.Literal('accessibility_snapshot'),
  Type.Literal('screenshot'),
  Type.Literal('console'),
  Type.Literal('network'),
  Type.Literal('observation')
])

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

export function registerQaTools(pi: ExtensionAPI): void {
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
    execute: async (_id, params) => executeQaPlan(params)
  })

  pi.registerTool({
    name: 'qa_step',
    label: 'QA Step',
    description:
      'Record one structured QA assertion against the active run. Pass and fail steps require expected, observed, and at least one evidence id captured during this run. Invalid steps are rejected.',
    promptSnippet:
      'Use qa_step after each meaningful browser assertion. Cite evidence ids that Pi assigned (E1, E2, ...). Title describes the assertion, not the click.',
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
    execute: async (_id, params) => executeQaStep(params)
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

async function executeQaPlan(params: QaPlanInput) {
  const active = getActiveRun(params.runId)
  if (!active) {
    const text = `qa_plan rejected: no active QA run with runId ${params.runId}. Start a /qa, /qa:staged, or /qa:freehand command first, then submit the plan using the runId from the command prompt.`
    return {
      content: [{ type: 'text' as const, text }],
      details: { accepted: false, runId: params.runId, acceptedScenarioIds: [], missing: ['no active QA run'], invalid: [] },
      isError: true
    }
  }

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

async function executeQaStep(params: QaStepInput) {
  const active = getActiveRun(params.runId)
  if (!active) {
    return {
      content: [{ type: 'text' as const, text: `qa_step rejected: no active QA run with runId ${params.runId}.` }],
      details: { accepted: false, invalid: ['no active QA run'] },
      isError: true
    }
  }
  const result = validateQaStep(active, params)
  if (!result.accepted) {
    return {
      content: [{ type: 'text' as const, text: `qa_step rejected:\n${result.invalid.map((entry) => `- ${entry}`).join('\n')}` }],
      details: result,
      isError: true
    }
  }
  const record = recordQaStep(active, params)
  return {
    content: [{ type: 'text' as const, text: `qa_step accepted: ${record.scenarioId} ${record.title} [${record.status}]` }],
    details: { accepted: true, record },
    isError: false
  }
}

async function executeQaFinish(params: QaFinishInput, cwd: string, pi: ExtensionAPI, ctx: Pick<ExtensionContext, 'ui'>) {
  try {
    const active = getActiveRun(params.runId)
    if (!active) {
      return {
        content: [{ type: 'text' as const, text: `qa_finish rejected: no active QA run with runId ${params.runId}.` }],
        details: { status: 'inconclusive', blockers: ['no active QA run'] },
        isError: true
      }
    }

    const result = computeQaFinish(active, params)
    const artifacts = await writeQaFinishArtifacts(cwd, result)
    const text = `${renderFinishSummary(result)}\n${renderArtifactSummary(artifacts)}`
    return {
      content: [{ type: 'text' as const, text }],
      details: { ...result, artifacts },
      isError: result.status !== 'pass' || artifacts.blocked
    }
  } finally {
    clearPendingCapturesForRun(params.runId)
    clearActiveRun(params.runId)
    await restoreQaConfigForRun(pi, ctx, params.runId)
  }
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
