// ## TOOLS ## //
// LLM-callable QA helpers. Reports go through a validator before becoming final
// so missing evidence cannot silently turn into pass/fail certainty.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import { writeQaArtifacts } from './artifacts.ts'
import { normalizeQaReport } from './report.ts'

const ReportStatus = Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Literal('inconclusive')])
const ReportMode = Type.Union([Type.Literal('mission'), Type.Literal('staged'), Type.Literal('freehand')])
const EvidenceType = Type.Union([
  Type.Literal('accessibility_snapshot'),
  Type.Literal('screenshot'),
  Type.Literal('console'),
  Type.Literal('network'),
  Type.Literal('observation')
])

const Evidence = Type.Object({
  id: Type.String({ description: 'Short evidence ID, for example E1.' }),
  type: EvidenceType,
  summary: Type.String({ description: 'What was observed and how.' }),
  artifactPaths: Type.Optional(
    Type.Array(Type.String({ description: 'Local paths to screenshot artifacts to bundle into the QA report.' }))
  )
})

const Check = Type.Object({
  status: ReportStatus,
  claim: Type.String({ description: 'Pass, fail, or inconclusive check claim.' }),
  evidenceIds: Type.Optional(Type.Array(Type.String({ description: 'Evidence IDs supporting this claim.' })))
})

const Bug = Type.Object({
  claim: Type.String({ description: 'Bug claim. Must cite evidence.' }),
  evidenceIds: Type.Optional(Type.Array(Type.String({ description: 'Evidence IDs supporting this bug.' })))
})

export function registerQaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'qa_report',
    label: 'QA Report',
    description:
      'Submit a final agentic QA report. Pass/fail checks and bug claims without known evidence IDs are marked inconclusive; local artifacts are written only after safety gates pass.',
    promptSnippet:
      'Use qa_report for final QA reports. Every pass/fail check and bug claim needs evidenceIds referencing evidence entries. Failed reports need screenshot evidence with artifactPaths so screenshots are bundled and inlined.',
    parameters: Type.Object({
      status: ReportStatus,
      target: Type.Optional(Type.String({ description: 'Localhost target URL, if configured.' })),
      mode: ReportMode,
      slug: Type.Optional(Type.String({ description: 'QA run slug. Used for .sworm/qa/<slug>/<runId>.' })),
      runId: Type.Optional(Type.String({ description: 'QA run timestamp/id. Used for .sworm/qa/<slug>/<runId>.' })),
      summary: Type.String(),
      evidence: Type.Array(Evidence),
      checks: Type.Array(Check),
      bugs: Type.Optional(Type.Array(Bug)),
      safetyNotes: Type.Optional(Type.Array(Type.String())),
      nextSteps: Type.Optional(Type.Array(Type.String()))
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const result = normalizeQaReport(params)
      const artifacts = await writeQaArtifacts(ctx.cwd, params, result)
      const artifactSummary = artifacts.written
        ? [
            '',
            '',
            'Artifacts:',
            `- report: ${artifacts.reportPath}`,
            `- evidence: ${artifacts.evidencePath}`,
            artifacts.artifactDir ? `- artifacts: ${artifacts.artifactDir}` : undefined
          ]
            .filter(Boolean)
            .join('\n')
        : artifacts.blocked
          ? `\n\nArtifacts blocked:\n${artifacts.reasons.map((reason) => `- ${reason}`).join('\n')}`
          : ''
      return {
        content: [{ type: 'text' as const, text: `${artifacts.markdown ?? result.markdown}${artifactSummary}` }],
        details: { ...result, artifacts },
        isError: artifacts.blocked
      }
    }
  })
}
