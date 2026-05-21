// ## ARTIFACTS ## //
// Local/private QA artifact writing. Reports live under ~/.pi/agent so browser
// evidence does not land in project git by accident.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isLocalhostQaTarget } from './config.ts'
import type { QaEvidence, QaReportInput, QaReportResult } from './report.ts'

export interface QaArtifactResult {
  readonly written: boolean
  readonly blocked: boolean
  readonly reasons: readonly string[]
  readonly reportPath?: string
  readonly evidencePath?: string
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\bauthorization\s*[:=]\s*bearer\s+\S+/i,
  /\bpassword\s*[:=]\s*\S+/i,
  /\btoken\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
]

export function writeQaArtifacts(cwd: string, input: QaReportInput, result: QaReportResult): QaArtifactResult {
  const reasons = artifactBlockers(input, result)
  if (reasons.length > 0) return { written: false, blocked: true, reasons }

  const artifactDir = path.join(artifactRoot(), safePathSegment(path.basename(cwd)), timestampSegment())
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 })

  const reportPath = path.join(artifactDir, 'report.md')
  const evidencePath = path.join(artifactDir, 'evidence.json')
  if (!isSafeArtifactPath(artifactDir, reportPath) || !isSafeArtifactPath(artifactDir, evidencePath)) {
    return { written: false, blocked: true, reasons: ['QA artifact path escaped the artifact directory.'] }
  }
  writeFileSync(reportPath, `${result.markdown}\n`, { mode: 0o600 })
  writeFileSync(evidencePath, `${JSON.stringify(input.evidence, null, 2)}\n`, { mode: 0o600 })

  return { written: true, blocked: false, reasons: [], reportPath, evidencePath }
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
  if (result.status === 'fail' && !hasScreenshotEvidence(input.evidence)) {
    reasons.push('Failed QA reports require screenshot evidence before local artifacts are written.')
  }

  return reasons
}

function hasScreenshotEvidence(evidence: readonly QaEvidence[]): boolean {
  return evidence.some((item) => item.type === 'screenshot')
}

function containsCredentialLeak(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))
}

export function isSafeArtifactPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function artifactRoot(): string {
  return path.join(process.env.PI_QA_ARTIFACT_DIR ?? path.join(process.env.HOME ?? '.', '.pi', 'agent', 'qa-artifacts'))
}

function timestampSegment(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'workspace'
}
