export const REVIEW_SEVERITIES = ['Blocking', 'Required', 'Suggestion'] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

export const REVIEW_SCOPES = [
  'Architecture Fit',
  'Primitive & Pattern Reuse',
  'Idiom Compliance',
  'Quality',
  'Efficiency',
  'Comment Style'
] as const
export type ReviewScope = (typeof REVIEW_SCOPES)[number]

export const REVIEW_AGENT_REGISTRY = [
  { agent: 'review.review-architecture-scout', scope: 'Architecture Fit' },
  { agent: 'review.review-reuse-scout', scope: 'Primitive & Pattern Reuse' },
  { agent: 'review.review-idiom-scout', scope: 'Idiom Compliance' },
  { agent: 'review.review-quality-scout', scope: 'Quality' },
  { agent: 'review.review-efficiency-scout', scope: 'Efficiency' },
  { agent: 'review.review-comment-scout', scope: 'Comment Style' }
] as const

export const REVIEW_SEVERITY_RANK: Record<ReviewSeverity, number> = {
  Blocking: 0,
  Required: 1,
  Suggestion: 2
}

export interface ReviewCard {
  severity: ReviewSeverity
  scope: ReviewScope
  location: string
  problem: string
  evidence: string
  fixDirection: string
}

export interface ReviewCardHeader {
  index: number
  severity: ReviewSeverity
  scope: ReviewScope
  location: string
}

export const REVIEW_CARD_SCHEMA_PROMPT = `Review findings must use this card schema exactly. Markdown pipe tables are forbidden.

Required fields per card:
- Severity: ${REVIEW_SEVERITIES.join(' | ')}
- Scope: ${REVIEW_SCOPES.join(' | ')}
- Location: code-formatted path:line, path:start-end, or multiple comma-separated path ranges. Do not report a finding if no file/range anchor is knowable.
- Problem: concrete failure mode, one or two sentences.
- Evidence: specific observed code/context proving the problem.
- Fix direction: imperative, specific repair direction.

Format:
── #<n> · <Severity> · <Scope> · <Location> ─────────────────
Problem: <failure mode>
Evidence: <specific evidence>
Fix direction: <specific repair>

No findings: write exactly \`No findings.\`.`

const CARD_HEADER_RE = /^──\s*#(\d+)\s*·\s*([^·]+?)\s*·\s*([^·]+?)\s*·\s*(.+?)\s*─+\s*$/
const CARD_FIELD_RE = /^([^:]+):\s*(.*)$/

export function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === 'string' && REVIEW_SEVERITIES.includes(value as ReviewSeverity)
}

export function isReviewScope(value: unknown): value is ReviewScope {
  return typeof value === 'string' && REVIEW_SCOPES.includes(value as ReviewScope)
}

export function normalizeReviewSeverity(value: string): ReviewSeverity | undefined {
  const normalized = value.trim().toLowerCase()
  return REVIEW_SEVERITIES.find((severity) => severity.toLowerCase() === normalized)
}

export function isReviewCardHeaderLine(line: string): boolean {
  return line.startsWith('── #')
}

export function parseReviewCardHeader(
  line: string
): { ok: true; header: ReviewCardHeader } | { ok: false; errors: string[] } {
  const match = line.match(CARD_HEADER_RE)
  if (!match) return { ok: false, errors: [`Malformed review card header: ${line}`] }

  const errors: string[] = []
  const severityText = match[2]?.trim() ?? ''
  const scopeText = match[3]?.trim() ?? ''
  const location = cleanReviewLocation(match[4] ?? '')
  const severity = normalizeReviewSeverity(severityText)

  if (!severity) errors.push(`Invalid review severity: ${severityText}`)
  if (!isReviewScope(scopeText)) errors.push(`Invalid review scope: ${scopeText}`)
  if (!isAnchoredLocation(location))
    errors.push(`Review finding must cite a file/range location: ${location || '<missing>'}`)
  if (errors.length > 0 || !severity || !isReviewScope(scopeText)) return { ok: false, errors }

  return {
    ok: true,
    header: {
      index: Number(match[1] ?? '0'),
      severity,
      scope: scopeText,
      location
    }
  }
}

export function parseReviewCardField(
  line: string
): { key: 'problem' | 'evidence' | 'fixDirection'; value: string } | undefined {
  const match = line.match(CARD_FIELD_RE)
  const label = match?.[1]?.trim()
  const value = match?.[2]?.trim() ?? ''
  if (label === 'Problem') return { key: 'problem', value }
  if (label === 'Evidence') return { key: 'evidence', value }
  if (label === 'Fix direction') return { key: 'fixDirection', value }
  return undefined
}

export function renderReviewCardHeader(
  index: number,
  card: Pick<ReviewCard, 'severity' | 'scope' | 'location'>
): string {
  return `── #${index} · ${card.severity} · ${card.scope} · ${card.location} ─────────────────`
}

function cleanReviewLocation(value: string): string {
  return value.trim().replace(/^`|`$/g, '')
}

function isAnchoredLocation(value: string): boolean {
  if (!value || value.toLowerCase() === 'unknown') return false
  return /[^\s:]+:\d+/.test(value)
}
