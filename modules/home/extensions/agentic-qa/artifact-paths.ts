// ## ARTIFACT PATHS ## //
// Shared QA artifact path helpers used by command prompts and report writing.

import path from 'node:path'
import type { QaReportInput } from './report.ts'

export interface QaArtifactPlan {
  readonly slug: string
  readonly runId: string
  readonly relativeRunDir: string
  readonly relativeArtifactDir: string
}

export const QA_ARTIFACT_SUBDIR = 'artifacts'

export function buildQaArtifactPlan(slug: string): QaArtifactPlan {
  const safeSlug = safePathSegment(slug)
  const runId = timestampSegment()
  const relativeRunDir = qaRelativeRunDir(safeSlug, runId)
  return {
    slug: safeSlug,
    runId,
    relativeRunDir,
    relativeArtifactDir: `${relativeRunDir}/${QA_ARTIFACT_SUBDIR}`
  }
}

export function qaRunDir(cwd: string, input: Pick<QaReportInput, 'slug' | 'mode' | 'runId'>): string {
  return path.join(cwd, qaRelativeRunDir(input.slug ?? input.mode, safeRunId(input.runId)))
}

export function safeRunId(value: string | undefined): string {
  if (value && /^[A-Za-z0-9._-]+$/.test(value)) return value
  return timestampSegment()
}

export function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'qa-run'
}

export function toMarkdownPath(value: string): string {
  return value.split(path.sep).join('/')
}

function qaRelativeRunDir(slug: string, runId: string): string {
  return toMarkdownPath(path.join('.sworm', 'qa', safePathSegment(slug), safeRunId(runId)))
}

function timestampSegment(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
