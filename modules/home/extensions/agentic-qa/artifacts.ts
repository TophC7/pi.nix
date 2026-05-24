// ## ARTIFACTS ## //
// Project-local QA artifact writing driven by the computed QaFinishResult.
// report.json is the canonical run object; report.md is generated from it so
// markdown layout stays deterministic and the agent cannot author it.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { QA_ARTIFACT_SUBDIR, safePathSegment, toMarkdownPath } from './artifact-paths.ts'
import { isLocalhostQaTarget } from './config.ts'
import type {
  QaEvidenceRecord,
  QaFinishBug,
  QaFinishResult,
  QaScenarioCoverage,
  QaStepRecord
} from './run-state.ts'

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
  lines.push(`# QA Report: ${finish.spec.slug}`)
  lines.push('')
  lines.push('| Status | Target | Mode | Run ID | Duration |')
  lines.push('|---|---|---|---|---|')
  lines.push(`| ${finish.status} | ${finish.spec.target} | ${finish.spec.mode} | ${finish.runId} | ${duration} |`)
  lines.push('')
  lines.push('## Summary')
  lines.push(finish.summary || '<no summary>')
  lines.push('')

  lines.push('## Coverage')
  if (finish.coverage.length === 0) lines.push('- no scenarios in run spec')
  else for (const entry of finish.coverage) lines.push(`- ${coverageMarker(entry)} ${entry.scenarioId} ${entry.title}`)
  lines.push(`- Missing evidence: ${finish.missingEvidence.length ? finish.missingEvidence.join(', ') : 'none'}`)
  if (finish.blockers.length) {
    lines.push('- Blockers:')
    for (const blocker of finish.blockers) lines.push(`  - ${blocker}`)
  }
  lines.push('')

  lines.push('## Steps')
  if (finish.steps.length === 0) lines.push('- no qa_step records were submitted')
  else {
    const evidenceById = new Map(finish.evidence.map((entry) => [entry.id, entry] as const))
    let index = 0
    for (const step of finish.steps) {
      index += 1
      lines.push(`### ${stepMarker(step)} ${index}. ${step.title} [${step.scenarioId}]`)
      lines.push('Expected:')
      if (step.expected.length === 0) lines.push('- (none)')
      else for (const value of step.expected) lines.push(`- ${value}`)
      lines.push('Observed:')
      if (step.observed.length === 0) lines.push('- (none)')
      else for (const value of step.observed) lines.push(`- ${value}`)
      lines.push('Evidence:')
      if (step.evidenceIds.length === 0) lines.push('- (none cited)')
      else for (const evidenceId of step.evidenceIds) {
        const evidence = evidenceById.get(evidenceId)
        lines.push(`- ${evidenceId}${evidence ? ` ${evidence.type} \u2014 ${formatEvidenceSummary(evidence)}` : ' (unknown)'}`)
        appendArtifactImages(lines, evidenceId, artifacts)
      }
      lines.push('')
    }
  }

  lines.push('## Bugs')
  if (finish.bugs.length === 0) lines.push('- none')
  else for (const bug of finish.bugs) lines.push(`- ${bug.claim}${formatEvidenceRefs(bug.evidenceIds)}`)
  if (finish.failures.length) {
    lines.push('- Failures:')
    for (const failure of finish.failures) lines.push(`  - ${failure}`)
  }
  lines.push('')

  lines.push('## Evidence')
  if (finish.evidence.length === 0) lines.push('- none')
  else for (const evidence of finish.evidence) {
    lines.push(`- ${evidence.id} ${evidence.type} \u2014 ${formatEvidenceSummary(evidence)}`)
    appendArtifactImages(lines, evidence.id, artifacts)
  }
  lines.push('')

  lines.push('## Safety notes')
  if (finish.safetyNotes.length === 0) lines.push('- none')
  else for (const note of finish.safetyNotes) lines.push(`- ${note}`)
  lines.push('')

  lines.push('## Next steps')
  if (finish.nextSteps.length === 0) lines.push('- none')
  else for (const step of finish.nextSteps) lines.push(`- ${step}`)

  return lines.join('\n')
}

function formatEvidenceSummary(evidence: QaEvidenceRecord): string {
  if (evidence.type === 'screenshot') return evidence.inputSummary || 'screenshot captured'
  return evidence.summary || evidence.inputSummary || '(no summary)'
}

function appendArtifactImages(
  lines: string[],
  evidenceId: string,
  artifacts: ReadonlyMap<string, readonly EvidenceArtifact[]>
): void {
  for (const artifact of artifacts.get(evidenceId) ?? []) {
    lines.push('')
    lines.push(`![${evidenceId} screenshot](${artifact.relativePath})`)
  }
}

function coverageMarker(entry: QaScenarioCoverage): string {
  if (entry.status === 'planned-tested') return '[tested]'
  if (entry.status === 'out-of-scope') return '[skip]'
  return '[gap]'
}

function stepMarker(step: QaStepRecord): string {
  if (step.status === 'pass') return '[pass]'
  if (step.status === 'fail') return '[fail]'
  if (step.status === 'skipped') return '[skip]'
  return '[inconclusive]'
}

function formatEvidenceRefs(ids: readonly string[]): string {
  return ids.length ? ` [${ids.join(', ')}]` : ''
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
