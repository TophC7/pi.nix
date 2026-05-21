import {
  isReviewCardHeaderLine,
  parseReviewCardField,
  parseReviewCardHeader,
  REVIEW_SEVERITY_RANK,
  type ReviewCard
} from './schema.ts'

export interface QuarantinedReviewCard {
  rawHeader: string
  reasons: string[]
}

export interface ReviewSynthesisInput {
  rawFindings: string
  targetLabel: string
  contextNotes?: readonly string[]
}

export interface ReviewSynthesis {
  findings: ReviewCard[]
  quarantined: QuarantinedReviewCard[]
  report: string
}

export function synthesizeReview(input: ReviewSynthesisInput): ReviewSynthesis {
  const parsed = parseReviewCards(input.rawFindings)
  const findings = dedupeFindings(parsed.findings).sort(compareFindings)
  return {
    findings,
    quarantined: parsed.quarantined,
    report: renderReport({
      findings,
      quarantined: parsed.quarantined,
      targetLabel: input.targetLabel,
      contextNotes: input.contextNotes ?? []
    })
  }
}

interface ParseResult {
  findings: ReviewCard[]
  quarantined: QuarantinedReviewCard[]
}

function parseReviewCards(raw: string): ParseResult {
  const lines = raw.split('\n')
  const findings: ReviewCard[] = []
  const quarantined: QuarantinedReviewCard[] = []

  for (let index = 0; index < lines.length; index++) {
    const headerLine = lines[index] ?? ''
    if (!isReviewCardHeaderLine(headerLine)) continue

    const parsedHeader = parseReviewCardHeader(headerLine)
    if (!parsedHeader.ok) {
      quarantined.push({ rawHeader: headerLine.trim(), reasons: parsedHeader.errors })
      continue
    }

    const { severity, scope, location } = parsedHeader.header
    const fields: Partial<Pick<ReviewCard, 'problem' | 'evidence' | 'fixDirection'>> = {}
    let currentField: keyof typeof fields | undefined
    for (index++; index < lines.length; index++) {
      const line = lines[index] ?? ''
      if (isReviewCardHeaderLine(line)) {
        index--
        break
      }
      const field = parseReviewCardField(line)
      if (field) {
        currentField = field.key
        fields[field.key] = field.value
      } else if (currentField && line.trim()) {
        fields[currentField] = appendFieldLine(fields[currentField] ?? '', line.trim())
      }
    }

    const missing = missingRequiredFields(fields)
    if (missing.length > 0) {
      quarantined.push({
        rawHeader: headerLine.trim(),
        reasons: missing.map((field) => `missing ${field}`)
      })
      continue
    }

    findings.push({
      severity,
      scope,
      location,
      problem: fields.problem!,
      evidence: fields.evidence!,
      fixDirection: fields.fixDirection!
    })
  }

  return { findings, quarantined }
}

function appendFieldLine(value: string, line: string): string {
  return value ? `${value}\n${line}` : line
}

function missingRequiredFields(fields: Partial<Pick<ReviewCard, 'problem' | 'evidence' | 'fixDirection'>>): string[] {
  const missing: string[] = []
  if (!fields.problem) missing.push('Problem')
  if (!fields.evidence) missing.push('Evidence')
  if (!fields.fixDirection) missing.push('Fix direction')
  return missing
}

function dedupeFindings(findings: ReviewCard[]): ReviewCard[] {
  const byIdentity = new Map<string, ReviewCard>()
  for (const finding of findings) {
    const key = findingIdentity(finding)
    const existing = byIdentity.get(key)
    if (!existing) {
      byIdentity.set(key, finding)
      continue
    }
    byIdentity.set(key, {
      ...existing,
      evidence: mergeText(existing.evidence, finding.evidence, ' ; '),
      fixDirection: mergeText(existing.fixDirection, finding.fixDirection, ' ; ')
    })
  }
  return [...byIdentity.values()]
}

function findingIdentity(finding: ReviewCard): string {
  return [finding.severity, finding.scope, finding.location, normalizeIdentityText(finding.problem)]
    .join('\0')
    .toLowerCase()
}

function normalizeIdentityText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function compareFindings(a: ReviewCard, b: ReviewCard): number {
  return REVIEW_SEVERITY_RANK[a.severity] - REVIEW_SEVERITY_RANK[b.severity] || a.location.localeCompare(b.location)
}

function renderReport(args: {
  findings: ReviewCard[]
  quarantined: QuarantinedReviewCard[]
  targetLabel: string
  contextNotes: readonly string[]
}): string {
  const verdict = renderVerdict(args.findings, args.quarantined)
  return [
    '## Summary',
    renderSummary(args.findings, args.quarantined, args.targetLabel),
    '',
    '## Practical Findings Rundown',
    args.findings.length ? renderFindingsRundown(args.findings) : 'No findings.',
    '',
    '## Open Questions / Assumptions',
    renderAssumptions(args.contextNotes, args.quarantined),
    '',
    '## Verdict',
    verdict,
    ''
  ].join('\n')
}

function renderSummary(findings: ReviewCard[], quarantined: QuarantinedReviewCard[], targetLabel: string): string {
  if (findings.length === 0 && quarantined.length === 0) {
    return `Adversarial review of ${targetLabel} found no evidence-backed issues.`
  }
  const counts = countSeverities(findings)
  const parts = [
    counts.Blocking ? `${counts.Blocking} Blocking` : '',
    counts.Required ? `${counts.Required} Required` : '',
    counts.Suggestion ? `${counts.Suggestion} Suggestion` : ''
  ].filter(Boolean)
  const malformed = quarantined.length ? ` ${quarantined.length} malformed card(s) were quarantined.` : ''
  return `Adversarial review of ${targetLabel} found ${parts.join(', ') || 'no valid findings'}.${malformed}`
}

function countSeverities(findings: ReviewCard[]): Record<ReviewCard['severity'], number> {
  return findings.reduce(
    (counts, finding) => {
      counts[finding.severity] += 1
      return counts
    },
    { Blocking: 0, Required: 0, Suggestion: 0 }
  )
}

function renderAssumptions(contextNotes: readonly string[], quarantined: readonly QuarantinedReviewCard[]): string {
  const lines = [
    ...contextNotes.map((note) => `- ${note}`),
    ...quarantined.map(
      (card, index) =>
        `- Quarantined malformed card #${index + 1} (${card.rawHeader || '<missing header>'}): ${card.reasons.join('; ')}`
    )
  ]
  return lines.length ? lines.join('\n') : 'None.'
}

function renderVerdict(findings: readonly ReviewCard[], quarantined: readonly QuarantinedReviewCard[]): string {
  if (findings.some((finding) => finding.severity === 'Blocking' || finding.severity === 'Required')) {
    return 'Request Changes'
  }
  if (quarantined.length > 0) return 'Needs Discussion'
  return 'Approve'
}

function renderFindingsRundown(findings: readonly ReviewCard[]): string {
  const groups = REVIEW_SEVERITIES_IN_REPORT_ORDER.flatMap((severity) => {
    const group = findings.filter((finding) => finding.severity === severity)
    if (group.length === 0) return []
    return [`### ${severity}`, ...group.map((finding) => renderFinding(finding, findings.indexOf(finding) + 1))]
  })
  return groups.join('\n\n')
}

const REVIEW_SEVERITIES_IN_REPORT_ORDER: readonly ReviewCard['severity'][] = ['Blocking', 'Required', 'Suggestion']

function renderFinding(finding: ReviewCard, index: number): string {
  return [
    `#### ${index}. ${finding.scope}`,
    `- Where: ${formatLocations(finding.location)}`,
    `- Problem: ${finding.problem}`,
    `- Evidence: ${finding.evidence}`,
    `- Recommended fix: ${finding.fixDirection}`
  ].join('\n')
}

function formatLocations(location: string): string {
  return location
    .split(/,\s*/)
    .map((part) => `\`${part}\``)
    .join(', ')
}

function mergeText(a: string, b: string, separator = ', '): string {
  if (!b || a === b || a.includes(b)) return a
  if (!a) return b
  return `${a}${separator}${b}`
}
