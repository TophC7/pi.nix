// ## REPORT ## //
// Evidence-backed report normalization. The tool is intentionally stricter than
// prose: unsupported pass/fail/bug claims force an inconclusive report.

export type QaReportStatus = 'pass' | 'fail' | 'inconclusive'
export type QaEvidenceType = 'accessibility_snapshot' | 'screenshot' | 'console' | 'network' | 'observation'

export interface QaEvidence {
  readonly id: string
  readonly type: QaEvidenceType
  readonly summary: string
}

export interface QaCheck {
  readonly status: QaReportStatus
  readonly claim: string
  readonly evidenceIds?: readonly string[]
}

export interface QaBug {
  readonly claim: string
  readonly evidenceIds?: readonly string[]
}

export interface QaReportInput {
  readonly status: QaReportStatus
  readonly target?: string
  readonly mode: 'mission' | 'staged' | 'freehand'
  readonly summary: string
  readonly evidence: readonly QaEvidence[]
  readonly checks: readonly QaCheck[]
  readonly bugs?: readonly QaBug[]
  readonly safetyNotes?: readonly string[]
  readonly nextSteps?: readonly string[]
}

export interface QaReportResult {
  readonly status: QaReportStatus
  readonly markdown: string
  readonly unsupportedClaims: readonly string[]
}

export function normalizeQaReport(input: QaReportInput): QaReportResult {
  const evidenceIds = new Set(input.evidence.map((item) => item.id.trim()).filter(Boolean))
  const unsupportedClaims = findUnsupportedClaims(input, evidenceIds)
  const status: QaReportStatus = unsupportedClaims.length > 0 ? 'inconclusive' : input.status

  return {
    status,
    unsupportedClaims,
    markdown: renderQaReport({ ...input, status }, unsupportedClaims)
  }
}

function findUnsupportedClaims(input: QaReportInput, evidenceIds: ReadonlySet<string>): string[] {
  const unsupported: string[] = []

  for (const check of input.checks) {
    if (check.status === 'inconclusive') continue
    if (!hasKnownEvidence(check.evidenceIds, evidenceIds)) {
      unsupported.push(`${check.status} check lacks evidence: ${check.claim}`)
    }
  }

  for (const bug of input.bugs ?? []) {
    if (!hasKnownEvidence(bug.evidenceIds, evidenceIds)) {
      unsupported.push(`bug lacks evidence: ${bug.claim}`)
    }
  }

  return unsupported
}

function hasKnownEvidence(ids: readonly string[] | undefined, evidenceIds: ReadonlySet<string>): boolean {
  return Boolean(ids?.some((id) => evidenceIds.has(id.trim())))
}

function renderQaReport(input: QaReportInput, unsupportedClaims: readonly string[]): string {
  const bugs = input.bugs ?? []
  const safetyNotes = input.safetyNotes ?? []
  const nextSteps = input.nextSteps ?? []
  return [
    `Status: ${input.status}`,
    `Target: ${input.target?.trim() || '<missing>'}`,
    `Mode: ${input.mode}`,
    `Summary: ${input.summary}`,
    'Evidence:',
    ...renderEvidence(input.evidence),
    'Checks:',
    ...renderChecks(input.checks),
    'Bugs:',
    ...(bugs.length ? bugs.map(renderBug) : ['- none']),
    'Safety notes:',
    ...(safetyNotes.length ? safetyNotes.map((note) => `- ${note}`) : ['- none']),
    'Next steps:',
    ...(nextSteps.length ? nextSteps.map((step) => `- ${step}`) : ['- none']),
    ...(unsupportedClaims.length ? ['Unsupported claims forced inconclusive:', ...unsupportedClaims.map((claim) => `- ${claim}`)] : [])
  ].join('\n')
}

function renderEvidence(evidence: readonly QaEvidence[]): string[] {
  if (evidence.length === 0) return ['- none']
  return evidence.map((item) => `- ${item.id}: ${item.type} — ${item.summary}`)
}

function renderChecks(checks: readonly QaCheck[]): string[] {
  if (checks.length === 0) return ['- inconclusive: no checks reported']
  return checks.map((check) => {
    const refs = formatEvidenceRefs(check.evidenceIds)
    return `- ${check.status}: ${check.claim}${refs}`
  })
}

function renderBug(bug: QaBug): string {
  return `- ${bug.claim}${formatEvidenceRefs(bug.evidenceIds)}`
}

function formatEvidenceRefs(ids: readonly string[] | undefined): string {
  const clean = ids?.map((id) => id.trim()).filter(Boolean) ?? []
  return clean.length ? ` [${clean.join(', ')}]` : ''
}
