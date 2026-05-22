// ## ARTIFACTS ## //
// Project-local QA artifact writing. Each run is bundled under
// .sworm/qa/<slug>/<timestamp>/ so reports, evidence metadata, and screenshots
// stay together with the project that produced them.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { QA_ARTIFACT_SUBDIR, qaRunDir, safePathSegment, toMarkdownPath } from './artifact-paths.ts'
import { isLocalhostQaTarget } from './config.ts'
import type { QaEvidence, QaReportInput, QaReportResult } from './report.ts'

export interface QaArtifactResult {
  readonly written: boolean
  readonly blocked: boolean
  readonly reasons: readonly string[]
  readonly reportPath?: string
  readonly evidencePath?: string
  readonly artifactDir?: string
  readonly artifactPaths?: readonly string[]
  readonly markdown?: string
}

interface EvidenceArtifact {
  readonly evidenceId: string
  readonly sourcePath: string
  readonly path: string
  readonly relativePath: string
}

interface ArtifactValidationResult {
  readonly artifact?: EvidenceArtifact
  readonly reason?: string
}

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

export async function writeQaArtifacts(cwd: string, input: QaReportInput, result: QaReportResult): Promise<QaArtifactResult> {
  const reasons = artifactBlockers(input, result)
  if (reasons.length > 0) return { written: false, blocked: true, reasons }

  const runDir = qaRunDir(cwd, input)
  const artifactDir = path.join(runDir, QA_ARTIFACT_SUBDIR)
  const reportPath = path.join(runDir, 'report.md')
  const evidencePath = path.join(runDir, 'evidence.json')

  if (![artifactDir, reportPath, evidencePath].every((candidate) => isSafeArtifactPath(runDir, candidate))) {
    return { written: false, blocked: true, reasons: ['QA artifact path escaped the run directory.'] }
  }

  const collected = await collectEvidenceArtifacts(cwd, input.evidence, artifactDir)
  if (collected.reasons.length > 0) return { written: false, blocked: true, reasons: collected.reasons }

  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  await copyEvidenceArtifactFiles(collected.artifacts)

  const artifactsByEvidenceId = groupArtifactsByEvidenceId(collected.artifacts)
  const markdown = inlineScreenshotArtifacts(result.markdown, artifactsByEvidenceId)
  const evidence = input.evidence.map((item) => ({
    ...item,
    bundledArtifactPaths: (artifactsByEvidenceId.get(item.id) ?? []).map((artifact) => artifact.relativePath)
  }))

  await writeFile(reportPath, `${markdown}\n`, { mode: 0o600 })
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })

  return {
    written: true,
    blocked: false,
    reasons: [],
    reportPath,
    evidencePath,
    artifactDir,
    artifactPaths: collected.artifacts.map((artifact) => artifact.path),
    markdown
  }
}

function artifactBlockers(input: QaReportInput, result: QaReportResult): string[] {
  const reasons: string[] = []

  if (!input.target) {
    reasons.push('QA artifacts blocked because no localhost target was provided.')
  } else if (!isLocalhostQaTarget(input.target)) {
    reasons.push(`QA artifacts blocked for non-localhost target: ${input.target}`)
  }
  if (containsCredentialLeak(result.markdown) || containsCredentialLeak(JSON.stringify(input.evidence))) {
    reasons.push('QA artifacts blocked because report or evidence appears to contain credentials or tokens.')
  }
  if (result.status === 'fail' && !hasScreenshotArtifact(input.evidence)) {
    reasons.push('Failed QA reports require screenshot evidence with a screenshot artifact path before local artifacts are written.')
  }

  return reasons
}

async function collectEvidenceArtifacts(
  cwd: string,
  evidence: readonly QaEvidence[],
  artifactDir: string
): Promise<{ readonly artifacts: readonly EvidenceArtifact[]; readonly reasons: readonly string[] }> {
  const candidates = evidence.flatMap((item) => {
    if (item.type !== 'screenshot') return []
    const sourcePaths = item.artifactPaths ?? []
    return sourcePaths.map((sourcePath, index) => ({ item, sourcePath, index, count: sourcePaths.length }))
  })

  const results: ArtifactValidationResult[] = await Promise.all(
    candidates.map(async ({ item, sourcePath, index, count }): Promise<ArtifactValidationResult> => {
      const source = path.resolve(cwd, sourcePath)
      if (!isSafeArtifactPath(cwd, source)) {
        return { reason: `Screenshot artifact for ${item.id} must be inside the workspace: ${sourcePath}` }
      }

      const ext = path.extname(source).toLowerCase()
      if (!SCREENSHOT_EXTENSIONS.has(ext)) {
        return { reason: `Screenshot artifact for ${item.id} must be a png, jpg, jpeg, or webp file: ${sourcePath}` }
      }

      let stats
      try {
        stats = await stat(source)
      } catch {
        return { reason: `Screenshot artifact for ${item.id} does not exist: ${sourcePath}` }
      }
      if (!stats.isFile()) {
        return { reason: `Screenshot artifact for ${item.id} is not a file: ${sourcePath}` }
      }
      if (stats.size > MAX_ARTIFACT_BYTES) {
        return { reason: `Screenshot artifact for ${item.id} is larger than ${MAX_ARTIFACT_BYTES} bytes: ${sourcePath}` }
      }

      const name = `${safePathSegment(item.id)}${count > 1 ? `-${index + 1}` : ''}${ext}`
      const destination = path.join(artifactDir, name)
      if (!isSafeArtifactPath(artifactDir, destination)) {
        return { reason: `Screenshot artifact for ${item.id} escaped the artifact directory: ${sourcePath}` }
      }
      return {
        artifact: {
          evidenceId: item.id,
          sourcePath: source,
          path: destination,
          relativePath: toMarkdownPath(path.join(QA_ARTIFACT_SUBDIR, name))
        }
      }
    })
  )

  return {
    artifacts: results.flatMap((result) => (result.artifact ? [result.artifact] : [])),
    reasons: results.flatMap((result) => (result.reason ? [result.reason] : []))
  }
}

async function copyEvidenceArtifactFiles(artifacts: readonly EvidenceArtifact[]): Promise<void> {
  await Promise.all(
    artifacts.map(async (artifact) => {
      if (path.resolve(artifact.sourcePath) !== path.resolve(artifact.path)) await copyFile(artifact.sourcePath, artifact.path)
    })
  )
}

function groupArtifactsByEvidenceId(artifacts: readonly EvidenceArtifact[]): Map<string, EvidenceArtifact[]> {
  const byEvidenceId = new Map<string, EvidenceArtifact[]>()
  for (const artifact of artifacts) {
    const group = byEvidenceId.get(artifact.evidenceId)
    if (group) {
      group.push(artifact)
    } else {
      byEvidenceId.set(artifact.evidenceId, [artifact])
    }
  }
  return byEvidenceId
}

function inlineScreenshotArtifacts(markdown: string, artifactsByEvidenceId: ReadonlyMap<string, readonly EvidenceArtifact[]>): string {
  if (artifactsByEvidenceId.size === 0) return markdown

  const lines: string[] = []
  for (const line of markdown.split('\n')) {
    lines.push(line)
    const match = line.match(/^- ([^:]+): screenshot\b/)
    if (!match) continue
    for (const artifact of artifactsByEvidenceId.get(match[1]?.trim() ?? '') ?? []) {
      lines.push(`  ![${artifact.evidenceId} screenshot](${artifact.relativePath})`)
    }
  }
  return lines.join('\n')
}

function hasScreenshotArtifact(evidence: readonly QaEvidence[]): boolean {
  return evidence.some((item) => item.type === 'screenshot' && (item.artifactPaths?.length ?? 0) > 0)
}

function containsCredentialLeak(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))
}

export function isSafeArtifactPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}
