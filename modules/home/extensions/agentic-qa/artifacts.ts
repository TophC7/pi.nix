// ## ARTIFACTS ## //
// Project-local QA artifact writing driven by the computed QaFinishResult.
// report.json is the canonical run object; report.md is generated from it so
// markdown layout stays deterministic and the agent cannot author it.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { singleLine } from '../pi-lib/subagents/render-helpers.ts'
import { QA_ARTIFACT_SUBDIR, safePathSegment, toMarkdownPath } from './artifact-paths.ts'
import { isLocalhostQaTarget } from './config.ts'
import type { QaEvidenceRecord, QaFinishBug, QaFinishResult, QaScenarioCoverage } from './run-state.ts'

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
const SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\bauthorization\s*[:=]\s*bearer\s+\S+/i,
  /\bpassword\s*[:=]\s*\S+/i,
  /\btoken\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
]

export interface QaArtifactResult {
  readonly written: boolean
  readonly blocked: boolean
  readonly reasons: readonly string[]
  readonly reportPath?: string
  readonly reportJsonPath?: string
  readonly artifactDir?: string
  readonly artifactPaths?: readonly string[]
  readonly markdown?: string
}

interface EvidenceArtifact {
  readonly evidenceId: string
  readonly sourcePath: string
  readonly destinationPath: string
  readonly relativePath: string
}

export async function writeQaFinishArtifacts(cwd: string, finish: QaFinishResult): Promise<QaArtifactResult> {
  const reasons = finishBlockers(finish)
  if (reasons.length > 0) return { written: false, blocked: true, reasons }

  const runDir = path.join(cwd, finish.spec.relativeRunDir)
  const artifactDir = path.join(runDir, QA_ARTIFACT_SUBDIR)
  const reportPath = path.join(runDir, 'report.md')
  const reportJsonPath = path.join(runDir, 'report.json')

  if (!isSafeArtifactPath(cwd, runDir)) {
    return { written: false, blocked: true, reasons: ['QA run directory escaped the workspace.'] }
  }
  if (![artifactDir, reportPath, reportJsonPath].every((candidate) => isSafeArtifactPath(runDir, candidate))) {
    return { written: false, blocked: true, reasons: ['QA artifact path escaped the run directory.'] }
  }

  const collected = await collectScreenshotArtifacts(cwd, finish.evidence, runDir, artifactDir)
  if (collected.reasons.length > 0) return { written: false, blocked: true, reasons: collected.reasons }

  const artifactsByEvidenceId = groupArtifactsByEvidenceId(collected.artifacts)
  const reportJson = buildReportJson(finish, artifactsByEvidenceId)
  const markdown = renderReportMarkdown(finish, artifactsByEvidenceId)

  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  await Promise.all([
    copyScreenshotArtifactFiles(collected.artifacts),
    writeFile(reportPath, `${markdown}\n`, { mode: 0o600 }),
    writeFile(reportJsonPath, `${JSON.stringify(reportJson, null, 2)}\n`, { mode: 0o600 })
  ])

  return {
    written: true,
    blocked: false,
    reasons: [],
    reportPath,
    reportJsonPath,
    artifactDir,
    artifactPaths: collected.artifacts.map((artifact) => artifact.destinationPath),
    markdown
  }
}

export function finishBlockers(finish: QaFinishResult): string[] {
  const reasons: string[] = []
  const target = finish.spec.target
  if (!target) reasons.push('QA artifacts blocked because no localhost target was provided.')
  else if (!isLocalhostQaTarget(target)) reasons.push(`QA artifacts blocked for non-localhost target: ${target}`)

  if (containsAnyCredentialLeak(finish)) {
    reasons.push('QA artifacts blocked because the run contains credential-looking content.')
  }

  if (finish.status === 'fail' && !hasScreenshotArtifact(finish.evidence)) {
    reasons.push('Failed QA runs require screenshot evidence with an artifact path before artifacts are written.')
  }

  return reasons
}

function containsAnyCredentialLeak(finish: QaFinishResult): boolean {
  const fragments: string[] = []
  fragments.push(finish.summary)
  for (const note of finish.safetyNotes) fragments.push(note)
  for (const step of finish.nextSteps) fragments.push(step)
  for (const bug of finish.bugs) fragments.push(bug.claim)
  for (const step of finish.steps) {
    fragments.push(step.title)
    for (const value of step.expected) fragments.push(value)
    for (const value of step.observed) fragments.push(value)
    for (const value of step.bugs) fragments.push(value)
  }
  for (const evidence of finish.evidence) {
    fragments.push(evidence.summary)
    fragments.push(evidence.inputSummary)
  }
  for (const plan of finish.acceptedPlan?.scenarios ?? []) {
    fragments.push(plan.title)
    for (const planStep of plan.plannedSteps) fragments.push(planStep)
    for (const evidence of plan.evidenceToCollect) fragments.push(evidence.purpose)
  }
  if (finish.spec.mission?.body) fragments.push(finish.spec.mission.body)
  if (finish.spec.mission?.title) fragments.push(finish.spec.mission.title)
  for (const item of finish.spec.setup) fragments.push(item)
  for (const item of finish.spec.outOfScope) fragments.push(item)
  for (const scenario of finish.spec.scenarios) {
    fragments.push(scenario.title)
    for (const value of scenario.given) fragments.push(value)
    for (const value of scenario.when) fragments.push(value)
    for (const value of scenario.then) fragments.push(value)
    for (const value of scenario.checks) fragments.push(value)
    for (const evidence of scenario.requiredEvidence) fragments.push(evidence.purpose)
  }
  for (const evidence of finish.spec.requiredEvidence) fragments.push(evidence.purpose)
  return fragments.some((value) => containsCredentialLeak(value ?? ''))
}

function buildReportJson(finish: QaFinishResult, artifacts: ReadonlyMap<string, readonly EvidenceArtifact[]>) {
  return {
    runId: finish.runId,
    status: finish.status,
    target: finish.spec.target,
    mode: finish.spec.mode,
    slug: finish.spec.slug,
    duration: computeRunDuration(finish),
    summary: finish.summary,
    coverage: finish.coverage,
    missingEvidence: finish.missingEvidence,
    blockers: finish.blockers,
    failures: finish.failures,
    spec: finish.spec,
    acceptedPlan: finish.acceptedPlan ?? null,
    steps: finish.steps,
    evidence: finish.evidence.map((evidence) => ({
      ...evidence,
      bundledArtifactPaths: (artifacts.get(evidence.id) ?? []).map((artifact) => artifact.relativePath)
    })),
    bugs: finish.bugs,
    safetyNotes: finish.safetyNotes,
    nextSteps: finish.nextSteps,
    generatedAt: new Date().toISOString()
  }
}

export function renderReportMarkdown(finish: QaFinishResult, artifacts: ReadonlyMap<string, readonly EvidenceArtifact[]>): string {
  const lines: string[] = []
  const duration = computeRunDuration(finish)
  const evidenceById = new Map(finish.evidence.map((entry) => [entry.id, entry] as const))
  const scenarioRows = buildScenarioResults(finish)

  lines.push(`# QA Report: ${finish.spec.slug}`)
  lines.push('')

  lines.push('## Result')
  lines.push('')
  lines.push(`Status: ${statusLabel(finish.status)}`)
  lines.push(`Target: ${finish.spec.target || 'unknown'}`)
  lines.push(`Run: ${finish.runId}`)
  lines.push(`Duration: ${duration}`)
  lines.push('')

  lines.push('## Executive Summary')
  lines.push('')
  for (const sentence of buildExecutiveSummary(finish, scenarioRows)) lines.push(escapeMarkdownText(sentence))
  lines.push('')

  lines.push('## Key Findings')
  lines.push('')
  lines.push('| Scenario | Finding | Evidence |')
  lines.push('|---|---|---|')
  for (const finding of buildKeyFindings(finish)) {
    lines.push(`| ${tableCell(finding.scenario)} | ${tableCell(finding.finding)} | ${tableCell(finding.evidence)} |`)
  }
  lines.push('')

  lines.push('## Scenario Results')
  lines.push('')
  lines.push('| Scenario | Result | Notes |')
  lines.push('|---|---|---|')
  for (const row of scenarioRows) {
    lines.push(`| ${tableCell(row.scenario)} | ${tableCell(row.result)} | ${tableCell(row.notes)} |`)
  }
  lines.push('')

  lines.push('## Ship Readiness')
  lines.push('')
  appendShipReadiness(lines, finish)
  lines.push('')

  lines.push('## Recommended Next Steps')
  lines.push('')
  appendNumberedList(lines, buildRecommendedNextSteps(finish))
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push('# Details')
  lines.push('')
  lines.push('Canonical run data: [report.json](report.json).')
  lines.push('')

  lines.push('## Assertions')
  lines.push('')
  if (finish.steps.length === 0) lines.push('- no qa_step records were submitted')
  else {
    for (const step of finish.steps) {
      lines.push(`### ${step.scenarioId} ${escapeMarkdownText(step.title)}`)
      lines.push('')
      lines.push(`Result: ${statusLabel(step.status)}`)
      lines.push('')
      lines.push('**Expected**')
      lines.push('')
      appendBulletList(lines, step.expected.length ? step.expected : ['(none)'])
      lines.push('')
      lines.push('**Observed**')
      lines.push('')
      appendBulletList(lines, step.observed.length ? step.observed : ['(none)'])
      lines.push('')
      lines.push('**Evidence**')
      lines.push('')
      if (step.evidenceIds.length === 0) lines.push('- (none cited)')
      else for (const evidenceId of step.evidenceIds) {
        const evidence = evidenceById.get(evidenceId)
        lines.push(`- ${escapeMarkdownText(formatEvidenceReference(evidenceId, evidence))}${formatEvidenceLinks(evidence, evidenceId, artifacts)}`)
      }
      lines.push('')
    }
  }

  lines.push('## Coverage')
  lines.push('')
  if (finish.coverage.length === 0) lines.push('- no scenarios in run spec')
  else for (const entry of finish.coverage) lines.push(`- ${coverageMarker(entry)} ${escapeMarkdownText(entry.scenarioId)} ${escapeMarkdownText(entry.title)}`)
  lines.push('')

  lines.push('## Blockers and Missing Evidence')
  lines.push('')
  lines.push('### Blockers')
  lines.push('')
  appendBulletList(lines, finish.blockers.length ? finish.blockers : ['none'])
  lines.push('')
  lines.push('### Missing Evidence')
  lines.push('')
  appendBulletList(lines, finish.missingEvidence.length ? finish.missingEvidence : ['none'])
  lines.push('')

  lines.push('## Evidence Appendix')
  lines.push('')
  lines.push('Full evidence records live in [report.json](report.json).')
  lines.push('')
  if (finish.evidence.length === 0) lines.push('- none')
  else {
    const appendixEvidence = selectMarkdownAppendixEvidence(finish)
    for (const evidence of appendixEvidence.included) appendEvidenceAppendixEntry(lines, evidence, artifacts)
    if (appendixEvidence.omittedCount > 0) {
      lines.push(`- ${appendixEvidence.omittedCount} uncited non-essential evidence record(s) omitted from markdown; see [report.json](report.json).`)
      lines.push('')
    }
  }
  lines.push('')

  lines.push('## Safety Notes')
  lines.push('')
  appendBulletList(lines, finish.safetyNotes.length ? finish.safetyNotes : ['none'])

  return lines.join('\n')
}

interface KeyFindingRow {
  readonly scenario: string
  readonly finding: string
  readonly evidence: string
}

interface ScenarioResultRow {
  readonly scenario: string
  readonly result: string
  readonly notes: string
}

type FinishStep = QaFinishResult['steps'][number]

function buildExecutiveSummary(finish: QaFinishResult, scenarioRows: readonly ScenarioResultRow[]): string[] {
  const counts = countScenarioResults(scenarioRows)
  const summary = finish.summary?.trim()
  const sentences: string[] = []
  sentences.push(`QA completed with ${statusLabel(finish.status)} status against ${finish.spec.target || 'the target'}.`)
  if (summary && !/^Aggregated \d+ QA shard\(s\):/i.test(summary)) sentences.push(summary)
  sentences.push(
    `${scenarioRows.length} scenario(s) reported: ${counts.Pass} pass, ${counts.Fail} fail, ${counts.Inconclusive} inconclusive, ${counts.Untested} untested, ${counts.Skipped} skipped.`
  )
  if (finish.bugs.length || finish.blockers.length || finish.missingEvidence.length) {
    sentences.push(`${finish.bugs.length} bug(s), ${finish.blockers.length} blocker(s), and ${finish.missingEvidence.length} missing evidence item(s) recorded.`)
  } else {
    sentences.push('No bugs, blockers, or missing evidence were recorded.')
  }
  return sentences.slice(0, 3)
}

function buildKeyFindings(finish: QaFinishResult): KeyFindingRow[] {
  const rows: KeyFindingRow[] = []
  for (const bug of finish.bugs) {
    rows.push({
      scenario: scenarioForEvidence(finish, bug.evidenceIds, bug.claim),
      finding: cleanFindingText(bug.claim),
      evidence: formatEvidenceRefsForTable(bug.evidenceIds)
    })
  }

  if (rows.length === 0) {
    for (const failure of finish.failures) {
      rows.push({ scenario: scenarioForText(finish, failure), finding: cleanFindingText(failure), evidence: '—' })
    }
  }

  if (rows.length === 0 && finish.blockers.length > 0) {
    for (const blocker of finish.blockers) {
      rows.push({ scenario: scenarioForText(finish, blocker), finding: cleanFindingText(blocker), evidence: '—' })
    }
  }

  if (rows.length === 0 && finish.missingEvidence.length > 0) {
    for (const missing of finish.missingEvidence) {
      rows.push({ scenario: scenarioForText(finish, missing), finding: `Missing evidence: ${cleanFindingText(missing)}`, evidence: '—' })
    }
  }

  if (rows.length === 0) rows.push({ scenario: 'All', finding: 'No material findings recorded.', evidence: '—' })
  return rows
}

function buildScenarioResults(finish: QaFinishResult): ScenarioResultRow[] {
  if (finish.coverage.length === 0) return [{ scenario: '—', result: 'Untested', notes: 'No scenarios in run spec.' }]
  const stepsByScenario = groupStepsByScenario(finish)
  return finish.coverage.map((entry) => {
    const steps = stepsByScenario.get(entry.scenarioId) ?? []
    return {
      scenario: `${entry.scenarioId} ${entry.title}`,
      result: scenarioResult(entry, steps),
      notes: scenarioNotes(finish, entry.scenarioId, steps)
    }
  })
}

function groupStepsByScenario(finish: QaFinishResult): Map<string, FinishStep[]> {
  const byScenario = new Map<string, FinishStep[]>()
  for (const step of finish.steps) {
    const steps = byScenario.get(step.scenarioId)
    if (steps) steps.push(step)
    else byScenario.set(step.scenarioId, [step])
  }
  return byScenario
}

function scenarioResult(entry: QaScenarioCoverage, steps: readonly FinishStep[]): string {
  if (entry.status === 'out-of-scope') return 'Skipped'
  if (entry.status === 'planned-untested' || entry.status === 'unplanned') return 'Untested'
  if (steps.some((step) => step.status === 'fail')) return 'Fail'
  if (steps.some((step) => step.status === 'inconclusive')) return 'Inconclusive'
  if (steps.length > 0 && steps.every((step) => step.status === 'pass')) return 'Pass'
  if (steps.some((step) => step.status === 'skipped')) return 'Skipped'
  return 'Inconclusive'
}

function scenarioNotes(finish: QaFinishResult, scenarioId: string, steps: readonly FinishStep[]): string {
  const failed = steps.find((step) => step.status === 'fail')
  if (failed) return firstUsefulText(failed.observed, true) || cleanFindingText(failed.title)
  const inconclusive = steps.find((step) => step.status === 'inconclusive')
  if (inconclusive) return firstUsefulText(inconclusive.observed, true) || cleanFindingText(inconclusive.title)
  const passed = steps.find((step) => step.status === 'pass')
  if (passed) return firstUsefulText(passed.observed) || cleanFindingText(passed.title)
  const missing = finish.missingEvidence.find((value) => value.includes(scenarioId))
  if (missing) return `Missing evidence: ${cleanFindingText(missing)}`
  const blocker = finish.blockers.find((value) => value.includes(scenarioId))
  if (blocker) return cleanFindingText(blocker)
  return 'No assertion details recorded.'
}

function appendShipReadiness(lines: string[], finish: QaFinishResult): void {
  if (finish.status === 'pass') {
    lines.push('Ready based on this QA run. No blocking issues were recorded.')
    return
  }

  if (finish.status === 'fail') lines.push('Not ready. Blocking issues:')
  else lines.push('Not ready to decide. Inconclusive issues:')

  appendBulletList(lines, buildShipReadinessIssues(finish))
}

function buildShipReadinessIssues(finish: QaFinishResult): string[] {
  const issues = finish.bugs.map((bug) => cleanFindingText(bug.claim))
  if (issues.length === 0) issues.push(...finish.failures.map(cleanFindingText))
  if (issues.length === 0) issues.push(...finish.blockers.map(cleanFindingText))
  if (issues.length === 0) issues.push(...finish.missingEvidence.map((item) => `Missing evidence: ${cleanFindingText(item)}`))
  return issues.length ? issues : ['No specific blocking issue was recorded.']
}

function buildRecommendedNextSteps(finish: QaFinishResult): string[] {
  if (finish.nextSteps.length > 0) return finish.nextSteps.map(cleanFindingText)
  const steps: string[] = []
  for (const bug of finish.bugs) steps.push(`Fix: ${cleanFindingText(bug.claim)}`)
  if (steps.length === 0) for (const failure of finish.failures) steps.push(`Investigate: ${cleanFindingText(failure)}`)
  if (finish.missingEvidence.length > 0) steps.push('Re-run QA with missing required evidence captured.')
  if (steps.length === 0 && finish.blockers.length > 0) steps.push('Resolve blockers and re-run QA.')
  if (steps.length === 0) steps.push('No follow-up required from this run.')
  return steps
}

function selectMarkdownAppendixEvidence(finish: QaFinishResult): { readonly included: readonly QaEvidenceRecord[]; readonly omittedCount: number } {
  const includedIds = collectMarkdownAppendixEvidenceIds(finish)
  const included = finish.evidence.filter((evidence) => includedIds.has(evidence.id) || evidence.type === 'screenshot' || evidence.isError)
  return { included, omittedCount: finish.evidence.length - included.length }
}

function collectMarkdownAppendixEvidenceIds(finish: QaFinishResult): Set<string> {
  const ids = new Set<string>()
  for (const step of finish.steps) for (const evidenceId of step.evidenceIds) ids.add(evidenceId)
  for (const bug of finish.bugs) for (const evidenceId of bug.evidenceIds) ids.add(evidenceId)
  for (const text of [...finish.blockers, ...finish.missingEvidence, ...finish.safetyNotes, ...finish.nextSteps]) addEvidenceIdsFromText(ids, text)
  return ids
}

function addEvidenceIdsFromText(ids: Set<string>, text: string): void {
  for (const match of text.matchAll(/\bE\d+\b/g)) {
    const evidenceId = match[0]
    if (evidenceId) ids.add(evidenceId)
  }
}

function appendEvidenceAppendixEntry(
  lines: string[],
  evidence: QaEvidenceRecord,
  artifacts: ReadonlyMap<string, readonly EvidenceArtifact[]>
): void {
  lines.push(`### ${evidence.id} ${evidence.type}`)
  lines.push('')
  lines.push(`- Summary: ${escapeMarkdownText(formatEvidenceTeaser(evidence))}`)
  lines.push(`- Full record: [report.json](report.json)`)
  const links = formatEvidenceLinks(evidence, evidence.id, artifacts)
  if (links) lines.push(`- Files: ${links.replace(/^ \(|\)$/g, '')}`)
  for (const artifact of artifacts.get(evidence.id) ?? []) {
    lines.push('')
    lines.push(`![${evidence.id} screenshot](${artifact.relativePath})`)
  }
  lines.push('')
}

function countScenarioResults(rows: readonly ScenarioResultRow[]): Record<'Pass' | 'Fail' | 'Inconclusive' | 'Untested' | 'Skipped', number> {
  const counts = { Pass: 0, Fail: 0, Inconclusive: 0, Untested: 0, Skipped: 0 }
  for (const row of rows) {
    if (row.result in counts) counts[row.result as keyof typeof counts] += 1
  }
  return counts
}

function scenarioForEvidence(finish: QaFinishResult, evidenceIds: readonly string[], fallbackText: string): string {
  const matchingStep = finish.steps.find((step) => step.evidenceIds.some((id) => evidenceIds.includes(id)))
  if (matchingStep) return scenarioLabel(finish, matchingStep.scenarioId)
  return scenarioForText(finish, fallbackText)
}

function scenarioForText(finish: QaFinishResult, text: string): string {
  const match = text.match(/\bS\d+\b/)
  return match ? scenarioLabel(finish, match[0]!) : 'Run-level'
}

function scenarioLabel(finish: QaFinishResult, scenarioId: string): string {
  const coverage = finish.coverage.find((entry) => entry.scenarioId === scenarioId)
  return coverage ? `${coverage.scenarioId} ${coverage.title}` : scenarioId
}

function firstUsefulText(values: readonly string[], preferProblem = false): string {
  const cleaned = values.map(cleanFindingText).filter(Boolean)
  if (preferProblem) {
    const problem = cleaned.find((value) => /\b(created|accepted|error|failed|failure|wrong|absent|remained|returned|500|empty|delete|not clean|not rejected)\b/i.test(value))
    if (problem) return problem
  }
  return cleaned[0] ?? ''
}

function cleanFindingText(value: string): string {
  return singleLine(
    value
      .replace(/^shard\s+\S+\s*:\s*/i, '')
      .replace(/^scenario\s+(S\d+)\s+failed\s*:\s*/i, '$1 failed: ')
  )
}

function appendBulletList(lines: string[], values: readonly string[]): void {
  for (const value of values) lines.push(`- ${escapeMarkdownText(value)}`)
}

function appendNumberedList(lines: string[], values: readonly string[]): void {
  values.forEach((value, index) => lines.push(`${index + 1}. ${escapeMarkdownText(value)}`))
}

function statusLabel(status: string): string {
  return status.toUpperCase()
}

function formatEvidenceReference(evidenceId: string, evidence: QaEvidenceRecord | undefined): string {
  if (!evidence) return `${evidenceId} (unknown)`
  return `${evidenceId} ${evidence.type} — ${formatEvidenceTeaser(evidence)}`
}

function formatEvidenceTeaser(evidence: QaEvidenceRecord): string {
  const summary = formatEvidenceSummary(evidence)
  const firstLine = summary.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
  return firstLine ? cleanFindingText(firstLine.replace(/^#+\s*/, '')) : '(no summary)'
}

function formatEvidenceLinks(
  evidence: QaEvidenceRecord | undefined,
  evidenceId: string,
  artifacts: ReadonlyMap<string, readonly EvidenceArtifact[]>
): string {
  const links: string[] = []
  for (const artifact of artifacts.get(evidenceId) ?? []) links.push(markdownLink('screenshot', artifact.relativePath))
  if (evidence) {
    for (const link of extractEvidenceLinks(formatEvidenceSummary(evidence))) links.push(link)
  }
  return links.length ? ` (${uniqueStrings(links).join(', ')})` : ''
}

function extractEvidenceLinks(value: string): string[] {
  const links: string[] = []
  const markdownLinks = value.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)
  for (const match of markdownLinks) {
    const target = match[1]?.trim()
    if (target) links.push(markdownLink(linkLabel(target), target))
  }

  const relativeFileLinks = value.matchAll(/(^|\s)(\.playwright-mcp\/[^\s)]+)/g)
  for (const match of relativeFileLinks) {
    const target = match[2]?.trim().replace(/[.,;:]+$/, '')
    if (target) links.push(markdownLink(linkLabel(target), target))
  }
  return links
}

function markdownLink(label: string, target: string): string {
  return `[${escapeMarkdownText(label)}](${target})`
}

function linkLabel(target: string): string {
  const clean = target.split('#')[0] ?? target
  const name = clean.split('/').at(-1) ?? clean
  return name || 'file'
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function escapeMarkdownText(value: string): string {
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function tableCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function formatEvidenceSummary(evidence: QaEvidenceRecord): string {
  if (evidence.type === 'screenshot') return evidence.inputSummary || 'screenshot captured'
  return evidence.summary || evidence.inputSummary || '(no summary)'
}

function coverageMarker(entry: QaScenarioCoverage): string {
  if (entry.status === 'planned-tested') return '[tested]'
  if (entry.status === 'out-of-scope') return '[skip]'
  return '[gap]'
}

function formatEvidenceRefsForTable(ids: readonly string[]): string {
  return ids.length ? ids.join(', ') : '—'
}

function computeRunDuration(finish: QaFinishResult): string {
  let minStart: number | undefined
  let maxEnd: number | undefined
  for (const record of finish.evidence) {
    const start = Date.parse(record.startedAt)
    if (!Number.isNaN(start)) minStart = minStart === undefined ? start : Math.min(minStart, start)
    if (record.endedAt) {
      const end = Date.parse(record.endedAt)
      if (!Number.isNaN(end)) maxEnd = maxEnd === undefined ? end : Math.max(maxEnd, end)
    }
  }
  for (const step of finish.steps) {
    const recorded = Date.parse(step.recordedAt)
    if (!Number.isNaN(recorded)) maxEnd = maxEnd === undefined ? recorded : Math.max(maxEnd, recorded)
  }
  if (minStart === undefined || maxEnd === undefined) return '0ms'
  return `${Math.max(0, maxEnd - minStart)}ms`
}

async function collectScreenshotArtifacts(
  cwd: string,
  evidence: readonly QaEvidenceRecord[],
  runDir: string,
  artifactDir: string
): Promise<{ artifacts: EvidenceArtifact[]; reasons: string[] }> {
  const reasons: string[] = []
  const artifacts: EvidenceArtifact[] = []

  for (const record of evidence) {
    if (record.type !== 'screenshot') continue
    if (record.artifactPaths.length === 0) continue
    const sourcePaths = record.artifactPaths
    for (let index = 0; index < sourcePaths.length; index += 1) {
      const sourcePath = sourcePaths[index]!
      const source = path.resolve(cwd, sourcePath)
      if (!isSafeArtifactPath(cwd, source)) {
        reasons.push(`Screenshot artifact for ${record.id} must be inside the workspace: ${sourcePath}`)
        continue
      }
      const ext = path.extname(source).toLowerCase()
      if (!SCREENSHOT_EXTENSIONS.has(ext)) {
        reasons.push(`Screenshot artifact for ${record.id} must be a png, jpg, jpeg, or webp file: ${sourcePath}`)
        continue
      }
      let stats
      try {
        stats = await stat(source)
      } catch {
        reasons.push(`Screenshot artifact for ${record.id} does not exist: ${sourcePath}`)
        continue
      }
      if (!stats.isFile()) {
        reasons.push(`Screenshot artifact for ${record.id} is not a file: ${sourcePath}`)
        continue
      }
      if (stats.size > MAX_ARTIFACT_BYTES) {
        reasons.push(`Screenshot artifact for ${record.id} is larger than ${MAX_ARTIFACT_BYTES} bytes: ${sourcePath}`)
        continue
      }
      const existingRunArtifact = isSafeArtifactPath(runDir, source)
      const name = `${safePathSegment(record.id)}${sourcePaths.length > 1 ? `-${index + 1}` : ''}${ext}`
      const destination = existingRunArtifact ? source : path.join(artifactDir, name)
      if (!existingRunArtifact && !isSafeArtifactPath(artifactDir, destination)) {
        reasons.push(`Screenshot artifact for ${record.id} escaped the artifact directory: ${sourcePath}`)
        continue
      }
      artifacts.push({
        evidenceId: record.id,
        sourcePath: source,
        destinationPath: destination,
        relativePath: toMarkdownPath(existingRunArtifact ? path.relative(runDir, source) : path.join(QA_ARTIFACT_SUBDIR, name))
      })
    }
  }

  return { artifacts, reasons }
}

async function copyScreenshotArtifactFiles(artifacts: readonly EvidenceArtifact[]): Promise<void> {
  await Promise.all(
    artifacts.map(async (artifact) => {
      if (path.resolve(artifact.sourcePath) !== path.resolve(artifact.destinationPath)) {
        await copyFile(artifact.sourcePath, artifact.destinationPath)
      }
    })
  )
}

function groupArtifactsByEvidenceId(artifacts: readonly EvidenceArtifact[]): Map<string, EvidenceArtifact[]> {
  const byEvidenceId = new Map<string, EvidenceArtifact[]>()
  for (const artifact of artifacts) {
    const group = byEvidenceId.get(artifact.evidenceId)
    if (group) group.push(artifact)
    else byEvidenceId.set(artifact.evidenceId, [artifact])
  }
  return byEvidenceId
}

function hasScreenshotArtifact(evidence: readonly QaEvidenceRecord[]): boolean {
  return evidence.some((record) => record.type === 'screenshot' && record.artifactPaths.length > 0)
}

export function containsCredentialLeak(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))
}

export function isSafeArtifactPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}
