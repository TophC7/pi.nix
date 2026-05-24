// ## MISSION CREATE ## //
// Typed `.qa.md` mission creation. Agents provide structured intent; Pi renders
// the canonical Markdown DSL so future `/qa` runs compile deterministically.

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toMarkdownPath } from './artifact-paths.ts'
import { containsCredentialLeak, isSafeArtifactPath } from './artifacts.ts'
import { QA_EVIDENCE_TYPE_HELP, normalizeQaEvidenceType, validateQaMissionSource, type QaEvidenceType } from './run-state.ts'

export interface QaMissionCreateEvidenceInput {
  readonly type: QaEvidenceType | string
  readonly purpose: string
}

export interface QaMissionCreateScenarioInput {
  readonly title: string
  readonly given: readonly string[]
  readonly when: readonly string[]
  readonly then: readonly string[]
  readonly checks: readonly string[]
  readonly requiredEvidence: readonly QaMissionCreateEvidenceInput[]
}

export interface QaMissionCreateInput {
  readonly path: string
  readonly title: string
  readonly purpose: string
  readonly setup?: readonly string[]
  readonly scenarios: readonly QaMissionCreateScenarioInput[]
  readonly outOfScope?: readonly string[]
  readonly tags?: readonly string[]
}

export interface QaMissionCreateResult {
  readonly created: boolean
  readonly path?: string
  readonly invalid: readonly string[]
  readonly markdown?: string
}

export async function createQaMissionFile(cwd: string, input: QaMissionCreateInput): Promise<QaMissionCreateResult> {
  const invalid = validateQaMissionCreateInput(cwd, input)
  if (invalid.length > 0) return { created: false, invalid }

  const target = resolveMissionPath(cwd, input.path)
  if (!target) return { created: false, invalid: ['path must be workspace-relative and stay inside the workspace'] }
  if (existsSync(target.absolutePath)) return { created: false, invalid: [`mission file already exists: ${target.relativePath}`] }

  const markdown = renderQaMission(input)
  const missionInvalid = validateQaMissionSource(markdown)
  if (missionInvalid.length > 0) return { created: false, invalid: missionInvalid.map((entry) => `rendered mission invalid: ${entry}`) }

  await mkdir(path.dirname(target.absolutePath), { recursive: true })
  await writeFile(target.absolutePath, markdown)
  return { created: true, path: target.relativePath, invalid: [], markdown }
}

export function renderQaMission(input: QaMissionCreateInput): string {
  const lines: string[] = []
  lines.push(`# ${oneLine(input.title)}`)
  lines.push('')
  lines.push(`Purpose: ${oneLine(input.purpose)}`)
  lines.push('')
  pushList(lines, 'Setup:', input.setup?.length ? input.setup : ['None'])
  lines.push('')

  for (const scenario of input.scenarios) {
    lines.push(`Scenario: ${oneLine(scenario.title)}`)
    pushList(lines, 'Given:', scenario.given)
    pushList(lines, 'When:', scenario.when)
    pushList(lines, 'Then:', scenario.then)
    pushList(lines, 'Checks:', scenario.checks)
    lines.push('Evidence required:')
    for (const evidence of scenario.requiredEvidence) {
      const type = normalizeQaEvidenceType(String(evidence.type)) ?? 'observation'
      lines.push(`- ${type}: ${oneLine(evidence.purpose)}`)
    }
    lines.push('')
  }

  pushList(lines, 'Out of scope:', input.outOfScope?.length ? input.outOfScope : ['None'])
  lines.push('')
  lines.push(`Tags: ${normalizeTags(input.tags ?? []).join(', ') || 'qa'}`)
  lines.push('')
  return lines.join('\n')
}

export function validateQaMissionCreateInput(cwd: string, input: QaMissionCreateInput): string[] {
  const invalid: string[] = []
  const target = resolveMissionPath(cwd, input.path)
  if (!target) invalid.push('path must be workspace-relative and stay inside the workspace')
  else if (!target.relativePath.endsWith('.qa.md')) invalid.push('path must end with .qa.md')

  requireText(input.title, 'title', invalid)
  requireText(input.purpose, 'purpose', invalid)
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) invalid.push('at least one scenario is required')

  for (const [index, scenario] of (input.scenarios ?? []).entries()) {
    const label = `scenario ${index + 1}`
    requireText(scenario.title, `${label} title`, invalid)
    requireNonEmptyTextArray(scenario.given, `${label} given`, invalid)
    requireNonEmptyTextArray(scenario.when, `${label} when`, invalid)
    requireNonEmptyTextArray(scenario.then, `${label} then`, invalid)
    requireNonEmptyTextArray(scenario.checks, `${label} checks`, invalid)
    if (!Array.isArray(scenario.requiredEvidence) || scenario.requiredEvidence.length === 0) {
      invalid.push(`${label} requiredEvidence must contain at least one item`)
    }
    for (const [evidenceIndex, evidence] of (scenario.requiredEvidence ?? []).entries()) {
      const evidenceLabel = `${label} requiredEvidence ${evidenceIndex + 1}`
      if (!normalizeQaEvidenceType(String(evidence.type))) {
        invalid.push(`${evidenceLabel} type "${String(evidence.type)}" is invalid. ${QA_EVIDENCE_TYPE_HELP}`)
      }
      requireText(evidence.purpose, `${evidenceLabel} purpose`, invalid)
    }
  }

  const textForLeakScan = JSON.stringify(input)
  if (containsCredentialLeak(textForLeakScan)) invalid.push('mission contains credential-looking content')
  return invalid
}

function resolveMissionPath(cwd: string, relativePath: string): { absolutePath: string; relativePath: string } | undefined {
  if (!relativePath || path.isAbsolute(relativePath)) return undefined
  const root = path.resolve(cwd)
  const absolutePath = path.resolve(root, relativePath)
  if (!isSafeArtifactPath(root, absolutePath)) return undefined
  return { absolutePath, relativePath: toMarkdownPath(path.relative(root, absolutePath)) }
}

function pushList(lines: string[], heading: string, values: readonly string[]): void {
  lines.push(heading)
  for (const value of values) lines.push(`- ${oneLine(value)}`)
}

function requireText(value: unknown, label: string, invalid: string[]): void {
  if (typeof value !== 'string' || !value.trim()) invalid.push(`${label} is required`)
}

function requireNonEmptyTextArray(value: readonly string[] | undefined, label: string, invalid: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.every((entry) => !entry.trim())) {
    invalid.push(`${label} must contain at least one item`)
  }
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.flatMap((tag) => oneLine(tag).split(/[,\s]+/)).map((tag) => tag.trim()).filter(Boolean))]
}

function oneLine(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}
