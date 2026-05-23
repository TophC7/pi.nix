// ## RUN STATE ## //
// QA run spec model. The run spec is the single object every later QA tool
// validates against. Mission missions get structured-section extraction with a
// conservative freeform fallback; staged and freehand contexts get provisional
// scenarios derived from their respective inputs.

import type { QaArtifactPlan } from './artifact-paths.ts'
import { containsCredentialLeak } from './artifacts.ts'
import { isLocalhostQaTarget } from './config.ts'
import type { QaMission } from './missions.ts'

export type QaMode = 'mission' | 'staged' | 'freehand'
export type QaEvidenceType =
  | 'accessibility_snapshot'
  | 'screenshot'
  | 'console'
  | 'network'
  | 'observation'

export interface QaRequiredEvidence {
  readonly type: QaEvidenceType
  readonly purpose: string
  readonly scenarioId?: string
}

export interface QaScenarioSpec {
  readonly id: string
  readonly title: string
  readonly given: readonly string[]
  readonly when: readonly string[]
  readonly then: readonly string[]
  readonly checks: readonly string[]
  readonly requiredEvidence: readonly QaRequiredEvidence[]
}

export interface QaMissionRef {
  readonly slug: string
  readonly relativePath: string
  readonly title?: string
  readonly body: string
}

export interface QaRunSpec {
  readonly target: string
  readonly mode: QaMode
  readonly slug: string
  readonly runId: string
  readonly relativeRunDir: string
  readonly relativeArtifactDir: string
  readonly mission?: QaMissionRef
  readonly setup: readonly string[]
  readonly scenarios: readonly QaScenarioSpec[]
  readonly requiredEvidence: readonly QaRequiredEvidence[]
  readonly outOfScope: readonly string[]
  readonly sourceFiles: readonly string[]
  readonly tags: readonly string[]
}

export interface ParsedMissionSections {
  readonly setup: readonly string[]
  readonly scenarios: readonly QaScenarioSpec[]
  readonly requiredEvidence: readonly QaRequiredEvidence[]
  readonly outOfScope: readonly string[]
  readonly tags: readonly string[]
}

const EVIDENCE_TYPES: Record<string, QaEvidenceType> = {
  accessibility_snapshot: 'accessibility_snapshot',
  'accessibility snapshot': 'accessibility_snapshot',
  snapshot: 'accessibility_snapshot',
  screenshot: 'screenshot',
  console: 'console',
  network: 'network',
  observation: 'observation'
}

// ### Section parsing ### //

export function parseMissionSections(body: string): ParsedMissionSections {
  const setup: string[] = []
  const outOfScope: string[] = []
  const tags: string[] = []
  const requiredEvidence: QaRequiredEvidence[] = []
  const scenarios: QaScenarioSpec[] = []

  let scenarioCounter = 0
  let activeScenario: MutableScenario | undefined
  let activeCollector: { kind: 'top' | 'scenario'; field: string } | undefined

  const finishScenario = (): void => {
    if (activeScenario) scenarios.push(freezeScenario(activeScenario))
    activeScenario = undefined
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const stripped = stripHeading(line).trim()

    const topHeading = parseTopHeading(stripped)
    if (topHeading) {
      const target = topHeading.field === 'requiredEvidence' && activeScenario
        ? { kind: 'scenario' as const, field: 'requiredEvidence' }
        : { kind: 'top' as const, field: topHeading.field }
      activeCollector = target
      if (topHeading.value) {
        if (target.kind === 'top') {
          appendTopValue({ setup, outOfScope, tags, requiredEvidence }, target.field, topHeading.value)
        } else if (activeScenario) {
          appendScenarioValue(activeScenario, target.field, topHeading.value)
        }
      }
      continue
    }

    const scenarioStart = parseScenarioHeading(stripped)
    if (scenarioStart) {
      finishScenario()
      scenarioCounter += 1
      activeScenario = makeScenario(scenarioCounter, scenarioStart)
      activeCollector = undefined
      continue
    }

    if (activeScenario) {
      const sub = parseScenarioSubsection(stripped)
      if (sub) {
        if (sub.value) appendScenarioValue(activeScenario, sub.field, sub.value)
        activeCollector = { kind: 'scenario', field: sub.field }
        continue
      }
    }

    if (!stripped) continue

    const bullet = parseBullet(line)
    const collector = activeCollector
    if (bullet !== undefined && collector) {
      if (collector.kind === 'top') {
        appendTopValue({ setup, outOfScope, tags, requiredEvidence }, collector.field, bullet)
      } else if (activeScenario) {
        appendScenarioValue(activeScenario, collector.field, bullet)
      }
    }
  }

  finishScenario()

  return { setup, scenarios, requiredEvidence, outOfScope, tags }
}

interface MutableScenario {
  readonly id: string
  title: string
  readonly given: string[]
  readonly when: string[]
  readonly then: string[]
  readonly checks: string[]
  readonly requiredEvidence: QaRequiredEvidence[]
}

function makeScenario(index: number, title: string): MutableScenario {
  return {
    id: `S${index}`,
    title: title || `Scenario ${index}`,
    given: [],
    when: [],
    then: [],
    checks: [],
    requiredEvidence: []
  }
}

function freezeScenario(scenario: MutableScenario): QaScenarioSpec {
  return {
    id: scenario.id,
    title: scenario.title,
    given: [...scenario.given],
    when: [...scenario.when],
    then: [...scenario.then],
    checks: [...scenario.checks],
    requiredEvidence: scenario.requiredEvidence.map((evidence) => ({ ...evidence, scenarioId: scenario.id }))
  }
}

function stripHeading(line: string): string {
  return line.replace(/^\s*#+\s*/, '').replace(/^\s*[-*]\s*/, '')
}

function parseTopHeading(stripped: string): { field: 'setup' | 'outOfScope' | 'tags' | 'requiredEvidence'; value: string } | undefined {
  const match = stripped.match(/^(setup|out of scope|tags|evidence required|required evidence)\s*[:：]?\s*(.*)$/i)
  if (!match) return undefined
  const rawField = match[1]?.toLowerCase() ?? ''
  const value = match[2]?.trim() ?? ''
  const field = normalizeTopField(rawField)
  if (!field) return undefined
  return { field, value }
}

function normalizeTopField(field: string): 'setup' | 'outOfScope' | 'tags' | 'requiredEvidence' | undefined {
  if (field === 'setup') return 'setup'
  if (field === 'out of scope') return 'outOfScope'
  if (field === 'tags') return 'tags'
  if (field === 'evidence required' || field === 'required evidence') return 'requiredEvidence'
  return undefined
}

function parseScenarioHeading(stripped: string): string | undefined {
  const match = stripped.match(/^scenario\s*[:：]\s*(.*)$/i)
  if (!match) return undefined
  return match[1]?.trim() ?? ''
}

function parseScenarioSubsection(stripped: string): { field: string; value: string } | undefined {
  const match = stripped.match(/^(given|when|then|checks|evidence required|required evidence)\s*[:：]?\s*(.*)$/i)
  if (!match) return undefined
  const rawField = match[1]?.toLowerCase() ?? ''
  const value = match[2]?.trim() ?? ''
  const field = normalizeScenarioField(rawField)
  if (!field) return undefined
  return { field, value }
}

function normalizeScenarioField(field: string): string | undefined {
  if (field === 'given' || field === 'when' || field === 'then' || field === 'checks') return field
  if (field === 'evidence required' || field === 'required evidence') return 'requiredEvidence'
  return undefined
}

function parseBullet(line: string): string | undefined {
  const match = line.match(/^\s*[-*]\s+(.*\S)\s*$/)
  if (match) return match[1]
  // Cucumber-style lines indented under Scenario.
  const indented = line.match(/^\s{2,}(\S.*?)\s*$/)
  if (indented) return indented[1]
  return undefined
}

function appendTopValue(
  collectors: { setup: string[]; outOfScope: string[]; tags: string[]; requiredEvidence: QaRequiredEvidence[] },
  field: string,
  value: string
): void {
  if (!value) return
  if (field === 'setup') collectors.setup.push(value)
  else if (field === 'outOfScope') collectors.outOfScope.push(value)
  else if (field === 'tags') {
    for (const tag of value.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean)) collectors.tags.push(tag)
  } else if (field === 'requiredEvidence') {
    const evidence = parseRequiredEvidence(value)
    if (evidence) collectors.requiredEvidence.push(evidence)
  }
}

function appendScenarioValue(scenario: MutableScenario, field: string, value: string): void {
  if (!value) return
  if (field === 'given') scenario.given.push(value)
  else if (field === 'when') scenario.when.push(value)
  else if (field === 'then') scenario.then.push(value)
  else if (field === 'checks') scenario.checks.push(value)
  else if (field === 'requiredEvidence') {
    const evidence = parseRequiredEvidence(value)
    if (evidence) scenario.requiredEvidence.push(evidence)
  }
}

function parseRequiredEvidence(line: string): QaRequiredEvidence | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const head = trimmed.slice(0, colon).trim().toLowerCase()
    const tail = trimmed.slice(colon + 1).trim()
    const type = EVIDENCE_TYPES[head]
    if (type) return { type, purpose: tail || head }
  }
  return { type: 'observation', purpose: trimmed }
}

// ### Run spec compilation ### //

export interface CompileMissionRunSpecInput {
  readonly target: string
  readonly artifacts: QaArtifactPlan
  readonly mission: QaMission
}

export interface CompileStagedRunSpecInput {
  readonly target: string
  readonly artifacts: QaArtifactPlan
  readonly stagedFiles: readonly string[]
}

export interface CompileFreehandRunSpecInput {
  readonly target: string
  readonly artifacts: QaArtifactPlan
  readonly prompt: string
}

export function compileMissionRunSpec(input: CompileMissionRunSpecInput): QaRunSpec {
  const sections = parseMissionSections(input.mission.body)
  const scenarios = sections.scenarios.length > 0
    ? sections.scenarios
    : [fallbackMissionScenario(input.mission, sections)]
  const requiredEvidence = collectMissionLevelEvidence(sections.requiredEvidence, scenarios)
  return {
    target: input.target,
    mode: 'mission',
    slug: input.artifacts.slug,
    runId: input.artifacts.runId,
    relativeRunDir: input.artifacts.relativeRunDir,
    relativeArtifactDir: input.artifacts.relativeArtifactDir,
    mission: {
      slug: input.mission.slug,
      relativePath: input.mission.relativePath,
      title: input.mission.title,
      body: input.mission.body
    },
    setup: sections.setup,
    scenarios,
    requiredEvidence,
    outOfScope: sections.outOfScope,
    sourceFiles: [input.mission.relativePath],
    tags: sections.tags
  }
}

export function compileStagedRunSpec(input: CompileStagedRunSpecInput): QaRunSpec {
  const scenario: QaScenarioSpec = {
    id: 'S1',
    title: 'Staged change verification (provisional)',
    given: [],
    when: [],
    then: [],
    checks: [],
    requiredEvidence: []
  }
  return {
    target: input.target,
    mode: 'staged',
    slug: input.artifacts.slug,
    runId: input.artifacts.runId,
    relativeRunDir: input.artifacts.relativeRunDir,
    relativeArtifactDir: input.artifacts.relativeArtifactDir,
    setup: [],
    scenarios: [scenario],
    requiredEvidence: [],
    outOfScope: [],
    sourceFiles: input.stagedFiles,
    tags: []
  }
}

export function compileFreehandRunSpec(input: CompileFreehandRunSpecInput): QaRunSpec {
  const title = input.prompt.trim().split(/\r?\n/)[0]?.slice(0, 80) || 'Freehand QA'
  return {
    target: input.target,
    mode: 'freehand',
    slug: input.artifacts.slug,
    runId: input.artifacts.runId,
    relativeRunDir: input.artifacts.relativeRunDir,
    relativeArtifactDir: input.artifacts.relativeArtifactDir,
    setup: [],
    scenarios: [{
      id: 'S1',
      title,
      given: [],
      when: [],
      then: [],
      checks: [],
      requiredEvidence: []
    }],
    requiredEvidence: [],
    outOfScope: [],
    sourceFiles: [],
    tags: []
  }
}

function fallbackMissionScenario(mission: QaMission, sections: ParsedMissionSections): QaScenarioSpec {
  return {
    id: 'S1',
    title: mission.title?.trim() || mission.slug,
    given: [],
    when: [],
    then: [],
    checks: sections.outOfScope.length === 0 ? inferFreeformChecks(mission.body) : [],
    requiredEvidence: sections.requiredEvidence.map((evidence) => ({ ...evidence, scenarioId: 'S1' }))
  }
}

function inferFreeformChecks(body: string): string[] {
  // Pull bulleted lines as conservative provisional checks; if there are none,
  // leave checks empty so qa_plan can demand explicit ones.
  const bullets: string[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*[-*]\s+(.*\S)\s*$/)
    if (match) bullets.push(match[1])
    if (bullets.length >= 6) break
  }
  return bullets
}

function collectMissionLevelEvidence(
  topLevel: readonly QaRequiredEvidence[],
  scenarios: readonly QaScenarioSpec[]
): QaRequiredEvidence[] {
  const seen = new Set<string>()
  const result: QaRequiredEvidence[] = []
  for (const evidence of topLevel) {
    const key = `${evidence.type}::${evidence.purpose}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(evidence)
  }
  for (const scenario of scenarios) {
    for (const evidence of scenario.requiredEvidence) {
      const key = `${evidence.type}::${evidence.purpose}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(evidence)
    }
  }
  return result
}

// ### Rendering ### //

export function renderRunSpec(spec: QaRunSpec): string {
  const lines: string[] = []
  lines.push('QA run spec:')
  lines.push(`  Slug: ${spec.slug}`)
  lines.push(`  Run ID: ${spec.runId}`)
  lines.push(`  Run dir: ${spec.relativeRunDir}`)
  lines.push(`  Artifact dir: ${spec.relativeArtifactDir}`)
  if (spec.mission) {
    lines.push(`  Mission: ${spec.mission.slug} (${spec.mission.relativePath})`)
  }
  if (spec.tags.length) lines.push(`  Tags: ${spec.tags.join(', ')}`)
  if (spec.setup.length) {
    lines.push('  Setup:')
    for (const item of spec.setup) lines.push(`    - ${item}`)
  }
  lines.push('  Scenarios:')
  for (const scenario of spec.scenarios) {
    lines.push(`    ${scenario.id} ${scenario.title}`)
    if (scenario.given.length) lines.push(`      Given: ${scenario.given.join('; ')}`)
    if (scenario.when.length) lines.push(`      When: ${scenario.when.join('; ')}`)
    if (scenario.then.length) lines.push(`      Then: ${scenario.then.join('; ')}`)
    if (scenario.checks.length) {
      lines.push('      Checks:')
      for (const check of scenario.checks) lines.push(`        - ${check}`)
    }
    if (scenario.requiredEvidence.length) {
      lines.push('      Required evidence:')
      for (const evidence of scenario.requiredEvidence) {
        lines.push(`        - ${evidence.type}: ${evidence.purpose}`)
      }
    }
  }
  if (spec.requiredEvidence.length) {
    lines.push('  Required evidence (run-level):')
    for (const evidence of spec.requiredEvidence) {
      const scope = evidence.scenarioId ? ` (${evidence.scenarioId})` : ''
      lines.push(`    - ${evidence.type}: ${evidence.purpose}${scope}`)
    }
  }
  if (spec.outOfScope.length) {
    lines.push('  Out of scope:')
    for (const item of spec.outOfScope) lines.push(`    - ${item}`)
  }
  if (spec.sourceFiles.length) {
    lines.push('  Source files:')
    for (const file of spec.sourceFiles) lines.push(`    - ${file}`)
  }
  return lines.join('\n')
}

// ### Active run registry ### //
// Module-scoped so tools registered in `tools.ts` can validate a plan against
// the run spec that `commands.ts` just compiled. One run id maps to one spec
// and at most one accepted plan.

export interface AcceptedQaPlan {
  readonly runId: string
  readonly target: string
  readonly acceptedScenarioIds: readonly string[]
  readonly scenarios: readonly QaPlanScenarioInput[]
  readonly outOfScope: readonly QaPlanOutOfScopeInput[]
  readonly safetyNotes: readonly string[]
  readonly acceptedAt: string
}

export interface QaEvidenceRecord {
  readonly id: string
  readonly type: QaEvidenceType
  readonly sourceTool: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly durationMs?: number
  readonly inputSummary: string
  readonly summary: string
  readonly artifactPaths: readonly string[]
  readonly isError: boolean
}

interface ActiveQaRun {
  readonly spec: QaRunSpec
  acceptedPlan?: AcceptedQaPlan
  evidence: QaEvidenceRecord[]
  steps: QaStepRecord[]
}

const activeRuns = new Map<string, ActiveQaRun>()
let currentRunId: string | undefined

export function registerActiveRun(spec: QaRunSpec): void {
  activeRuns.set(spec.runId, { spec, evidence: [], steps: [] })
  currentRunId = spec.runId
}

export function getActiveRun(runId: string): ActiveQaRun | undefined {
  return activeRuns.get(runId)
}

export function getCurrentRunId(): string | undefined {
  return currentRunId
}

export function clearActiveRun(runId: string): void {
  activeRuns.delete(runId)
  if (currentRunId === runId) currentRunId = undefined
}

export function appendEvidence(
  runId: string,
  partial: Omit<QaEvidenceRecord, 'id'>
): QaEvidenceRecord | undefined {
  const run = activeRuns.get(runId)
  if (!run) return undefined
  const id = `E${run.evidence.length + 1}`
  const record: QaEvidenceRecord = { id, ...partial }
  run.evidence.push(record)
  return record
}

export function getEvidence(runId: string): readonly QaEvidenceRecord[] {
  return activeRuns.get(runId)?.evidence ?? []
}

export function getSteps(runId: string): readonly QaStepRecord[] {
  return activeRuns.get(runId)?.steps ?? []
}

export function recordAcceptedPlan(runId: string, plan: AcceptedQaPlan): void {
  const run = activeRuns.get(runId)
  if (run) run.acceptedPlan = plan
}

// ### Plan validation ### //

export interface QaPlanScenarioInput {
  readonly scenarioId: string
  readonly title: string
  readonly plannedSteps: readonly string[]
  readonly evidenceToCollect: readonly QaRequiredEvidence[]
}

export interface QaPlanOutOfScopeInput {
  readonly scenarioId: string
  readonly reason: string
}

export interface QaPlanInput {
  readonly runId: string
  readonly target: string
  readonly scenarios: readonly QaPlanScenarioInput[]
  readonly outOfScope?: readonly QaPlanOutOfScopeInput[]
  readonly safetyNotes?: readonly string[]
}

export interface QaPlanResult {
  readonly accepted: boolean
  readonly runId: string
  readonly acceptedScenarioIds: readonly string[]
  readonly missing: readonly string[]
  readonly invalid: readonly string[]
}

const VAGUE_STEP_PATTERNS: readonly RegExp[] = [
  /^\s*explore( the)? (app|site|page|ui)\.?\s*$/i,
  /^\s*test( things| stuff)?\.?\s*$/i,
  /^\s*look around\.?\s*$/i,
  /^\s*check( everything| things)?\.?\s*$/i,
  /^\s*click around\.?\s*$/i,
  /^\s*just (test|check|explore).*$/i
]

const URL_PATTERN = /\bhttps?:\/\/([^\s/'"<>]+)/gi

export function validateQaPlan(spec: QaRunSpec, input: QaPlanInput): QaPlanResult {
  const missing: string[] = []
  const invalid: string[] = []
  const accepted: string[] = []

  if (input.runId !== spec.runId) {
    invalid.push(`runId mismatch: plan ${input.runId} vs active run ${spec.runId}`)
  }

  const planTarget = input.target?.trim() ?? ''
  if (!planTarget) {
    invalid.push('plan target is empty')
  } else {
    if (planTarget !== spec.target) invalid.push(`plan target ${planTarget} does not match run-spec target ${spec.target}`)
    if (!isLocalhostQaTarget(planTarget)) invalid.push(`plan target is not a localhost http(s) URL: ${planTarget}`)
  }

  const plannedIds = new Set<string>()
  const outOfScopeIds = new Set<string>()

  for (const item of input.outOfScope ?? []) {
    if (!item.reason?.trim()) {
      invalid.push(`out-of-scope scenario ${item.scenarioId} is missing a reason`)
      continue
    }
    outOfScopeIds.add(item.scenarioId)
  }

  if (input.scenarios.length === 0) {
    invalid.push('plan has no scenarios')
  }

  for (const planned of input.scenarios) {
    if (!planned.scenarioId?.trim()) {
      invalid.push('planned scenario is missing scenarioId')
      continue
    }
    if (plannedIds.has(planned.scenarioId)) {
      invalid.push(`planned scenario ${planned.scenarioId} listed twice`)
      continue
    }
    plannedIds.add(planned.scenarioId)

    if (!planned.title?.trim()) invalid.push(`scenario ${planned.scenarioId} is missing a title`)

    const steps = planned.plannedSteps.map((step) => step.trim()).filter(Boolean)
    if (steps.length === 0) {
      invalid.push(`scenario ${planned.scenarioId} has empty plannedSteps`)
    } else {
      for (const step of steps) {
        if (isVagueStep(step)) invalid.push(`scenario ${planned.scenarioId} step is vague: "${step}"`)
        if (containsCredentialLeak(step)) invalid.push(`scenario ${planned.scenarioId} step looks like a credential leak`)
        for (const url of extractUrls(step)) {
          if (!isLocalhostQaTarget(url)) invalid.push(`scenario ${planned.scenarioId} step references non-localhost URL: ${url}`)
        }
      }
    }

    for (const evidence of planned.evidenceToCollect) {
      if (!evidence.purpose?.trim()) {
        invalid.push(`scenario ${planned.scenarioId} evidence is missing a purpose`)
      } else if (containsCredentialLeak(evidence.purpose)) {
        invalid.push(`scenario ${planned.scenarioId} evidence purpose looks like a credential leak`)
      }
    }
  }

  for (const note of input.safetyNotes ?? []) {
    if (containsCredentialLeak(note)) invalid.push('safetyNotes contain a credential-looking value')
  }

  const knownScenarioIds = new Set(spec.scenarios.map((scenario) => scenario.id))

  for (const planned of input.scenarios) {
    if (planned.scenarioId && !knownScenarioIds.has(planned.scenarioId)) {
      invalid.push(`planned scenario ${planned.scenarioId} is not in the run spec`)
    }
  }
  for (const item of input.outOfScope ?? []) {
    if (!knownScenarioIds.has(item.scenarioId)) {
      invalid.push(`out-of-scope scenario ${item.scenarioId} is not in the run spec`)
    }
  }

  for (const scenario of spec.scenarios) {
    if (plannedIds.has(scenario.id)) continue
    if (outOfScopeIds.has(scenario.id)) continue
    missing.push(`run-spec scenario ${scenario.id} (${scenario.title}) is not planned and not marked out of scope`)
  }

  for (const evidence of spec.requiredEvidence) {
    const scenarioId = evidence.scenarioId
    if (scenarioId && outOfScopeIds.has(scenarioId)) continue
    if (scenarioId && plannedIds.has(scenarioId)) {
      const planned = input.scenarios.find((entry) => entry.scenarioId === scenarioId)
      const covered = planned?.evidenceToCollect.some((item) => item.type === evidence.type && item.purpose.trim() === evidence.purpose.trim())
      if (!covered) missing.push(`required evidence not planned for ${scenarioId}: ${evidence.type} (${evidence.purpose})`)
      continue
    }
    if (!scenarioId) {
      const covered = input.scenarios.some((entry) =>
        entry.evidenceToCollect.some((item) => item.type === evidence.type && item.purpose.trim() === evidence.purpose.trim())
      )
      if (!covered) missing.push(`required evidence not planned (run-level): ${evidence.type} (${evidence.purpose})`)
    }
  }

  for (const planned of input.scenarios) plannedIds.has(planned.scenarioId) && accepted.push(planned.scenarioId)

  const acceptedPlan = missing.length === 0 && invalid.length === 0
  return {
    accepted: acceptedPlan,
    runId: input.runId,
    acceptedScenarioIds: acceptedPlan ? accepted : [],
    missing,
    invalid
  }
}

function isVagueStep(step: string): boolean {
  if (step.split(/\s+/).length < 2) return true
  return VAGUE_STEP_PATTERNS.some((pattern) => pattern.test(step))
}

function extractUrls(value: string): string[] {
  const urls: string[] = []
  const matches = value.matchAll(URL_PATTERN)
  for (const match of matches) urls.push(match[0])
  return urls
}

// ### Step recording ### //

export type QaStepStatus = 'pass' | 'fail' | 'inconclusive' | 'skipped'

export interface QaStepInput {
  readonly runId: string
  readonly scenarioId: string
  readonly title: string
  readonly status: QaStepStatus
  readonly expected: readonly string[]
  readonly observed: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly bugs?: readonly string[]
}

export interface QaStepRecord {
  readonly runId: string
  readonly scenarioId: string
  readonly title: string
  readonly status: QaStepStatus
  readonly expected: readonly string[]
  readonly observed: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly bugs: readonly string[]
  readonly recordedAt: string
}

export interface QaStepValidationResult {
  readonly accepted: boolean
  readonly invalid: readonly string[]
}

export function validateQaStep(run: ActiveQaRun, input: QaStepInput): QaStepValidationResult {
  const invalid: string[] = []
  if (!run.acceptedPlan) invalid.push('no accepted qa_plan for this run; submit qa_plan before qa_step')
  if (!input.scenarioId?.trim()) invalid.push('scenarioId is required')
  else {
    const knownInSpec = run.spec.scenarios.some((scenario) => scenario.id === input.scenarioId)
    const knownInPlan = run.acceptedPlan?.scenarios.some((scenario) => scenario.scenarioId === input.scenarioId)
    if (!knownInSpec && !knownInPlan) invalid.push(`scenarioId ${input.scenarioId} is not in the run spec or accepted plan`)
  }
  if (!input.title?.trim()) invalid.push('title is required')

  const requiresEvidence = input.status === 'pass' || input.status === 'fail'
  if (requiresEvidence) {
    if (input.expected.length === 0) invalid.push(`${input.status} step requires at least one expected value`)
    if (input.observed.length === 0) invalid.push(`${input.status} step requires at least one observed value`)
    if (input.evidenceIds.length === 0) invalid.push(`${input.status} step must cite at least one evidence id`)
  }

  const knownEvidenceIds = new Set(run.evidence.map((record) => record.id))
  for (const evidenceId of input.evidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      invalid.push(`evidence ${evidenceId} was not captured during this run`)
    }
  }

  return { accepted: invalid.length === 0, invalid }
}

export function recordQaStep(run: ActiveQaRun, input: QaStepInput): QaStepRecord {
  const record: QaStepRecord = {
    runId: input.runId,
    scenarioId: input.scenarioId,
    title: input.title,
    status: input.status,
    expected: [...input.expected],
    observed: [...input.observed],
    evidenceIds: [...input.evidenceIds],
    bugs: input.bugs ? [...input.bugs] : [],
    recordedAt: new Date().toISOString()
  }
  run.steps.push(record)
  return record
}

// ### Finish computation ### //

export interface QaFinishBug {
  readonly claim: string
  readonly evidenceIds: readonly string[]
}

export interface QaFinishInput {
  readonly runId: string
  readonly summary: string
  readonly bugs?: readonly QaFinishBug[]
  readonly safetyNotes?: readonly string[]
  readonly nextSteps?: readonly string[]
}

export type QaScenarioCoverageStatus = 'planned-tested' | 'planned-untested' | 'out-of-scope' | 'unplanned'

export interface QaScenarioCoverage {
  readonly scenarioId: string
  readonly title: string
  readonly status: QaScenarioCoverageStatus
}

export interface QaFinishResult {
  readonly status: QaReportStatus
  readonly runId: string
  readonly summary: string
  readonly blockers: readonly string[]
  readonly failures: readonly string[]
  readonly coverage: readonly QaScenarioCoverage[]
  readonly missingEvidence: readonly string[]
  readonly bugs: readonly QaFinishBug[]
  readonly safetyNotes: readonly string[]
  readonly nextSteps: readonly string[]
  readonly evidence: readonly QaEvidenceRecord[]
  readonly steps: readonly QaStepRecord[]
  readonly acceptedPlan: AcceptedQaPlan | undefined
  readonly spec: QaRunSpec
}

export type QaReportStatus = 'pass' | 'fail' | 'inconclusive'

export function computeQaFinish(run: ActiveQaRun, input: QaFinishInput): QaFinishResult {
  const blockers: string[] = []
  const failures: string[] = []
  const missingEvidence: string[] = []
  const knownEvidenceIds = new Set(run.evidence.map((record) => record.id))
  const inputBugs = (input.bugs ?? []).map((bug) => ({
    claim: bug.claim,
    evidenceIds: [...bug.evidenceIds]
  }))

  for (const bug of inputBugs) {
    if (!bug.claim?.trim()) failures.push('bug claim is empty')
    if (bug.evidenceIds.length === 0) failures.push(`bug "${bug.claim}" has no evidence`)
    for (const evidenceId of bug.evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) failures.push(`bug "${bug.claim}" cites unknown evidence ${evidenceId}`)
    }
  }

  const failedSteps = run.steps.filter((step) => step.status === 'fail')
  for (const step of failedSteps) failures.push(`scenario ${step.scenarioId} failed: ${step.title}`)

  if (!run.acceptedPlan) blockers.push('no accepted qa_plan')
  if (run.evidence.length === 0) blockers.push('no browser evidence captured during this run')

  const plannedIds = new Set(run.acceptedPlan?.scenarios.map((scenario) => scenario.scenarioId) ?? [])
  const outOfScopeIds = new Set(run.acceptedPlan?.outOfScope.map((item) => item.scenarioId) ?? [])
  const testedIds = new Set(
    run.steps
      .filter((step) => step.status === 'pass' || step.status === 'fail')
      .map((step) => step.scenarioId)
  )

  const coverage: QaScenarioCoverage[] = run.spec.scenarios.map((scenario) => {
    if (outOfScopeIds.has(scenario.id)) return { scenarioId: scenario.id, title: scenario.title, status: 'out-of-scope' as const }
    if (plannedIds.has(scenario.id)) {
      const status: QaScenarioCoverageStatus = testedIds.has(scenario.id) ? 'planned-tested' : 'planned-untested'
      return { scenarioId: scenario.id, title: scenario.title, status }
    }
    return { scenarioId: scenario.id, title: scenario.title, status: 'unplanned' as const }
  })

  for (const entry of coverage) {
    if (entry.status === 'planned-untested') blockers.push(`scenario ${entry.scenarioId} planned but never tested`)
    if (entry.status === 'unplanned') blockers.push(`scenario ${entry.scenarioId} is not covered by the accepted plan`)
  }

  for (const required of run.spec.requiredEvidence) {
    if (required.scenarioId && outOfScopeIds.has(required.scenarioId)) continue
    const found = run.evidence.some((record) => record.type === required.type)
    if (!found) missingEvidence.push(`${required.type} (${required.purpose})`)
  }
  if (missingEvidence.length > 0) blockers.push(`missing required evidence: ${missingEvidence.join(', ')}`)

  const isFail = failedSteps.length > 0 || inputBugs.length > 0
  if (isFail) {
    const screenshotsWithPath = run.evidence.filter((record) => record.type === 'screenshot' && record.artifactPaths.length > 0)
    if (screenshotsWithPath.length === 0) blockers.push('failed run lacks a screenshot evidence record with an artifact path')
  }

  let status: QaReportStatus
  if (isFail && blockers.length === 0) status = 'fail'
  else if (isFail) status = 'inconclusive'
  else if (blockers.length > 0) status = 'inconclusive'
  else status = 'pass'

  return {
    status,
    runId: input.runId,
    summary: input.summary,
    blockers,
    failures,
    coverage,
    missingEvidence,
    bugs: inputBugs,
    safetyNotes: input.safetyNotes ? [...input.safetyNotes] : [],
    nextSteps: input.nextSteps ? [...input.nextSteps] : [],
    evidence: run.evidence,
    steps: run.steps,
    acceptedPlan: run.acceptedPlan,
    spec: run.spec
  }
}

