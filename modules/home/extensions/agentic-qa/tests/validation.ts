#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildQaArtifactPlan } from '../artifact-paths.ts'
import { computeAggregateQaFinish, writeAggregateQaReport } from '../aggregate.ts'
import { isSafeArtifactPath, writeQaFinishArtifacts } from '../artifacts.ts'
import { createQaMissionFile } from '../mission-create.ts'
import { runQaShardCoordinator } from '../coordinator.ts'
import {
  deferQaRestoreUntilFinish,
  registerQaModelRestoreLifecycle,
  restoreAllPendingQaConfig,
  restoreQaConfigForRun
} from '../model-restore.ts'
import { isLocalhostQaTarget } from '../config.ts'
import {
  collectStagedQaContext,
  discoverQaMissions,
  lookupQaMission,
  type QaCommandContext,
  type QaGitRunner,
  type QaMission
} from '../missions.ts'
import {
  beginCapture,
  extractScreenshotArtifactPath,
  finishCapture,
  mapPlaywrightToolToEvidenceType,
  sanitizeSummary,
  summarizePlaywrightArgs,
  summarizeToolResult
} from '../playwright-capture.ts'
import { registerQaTools } from '../tools.ts'
import {
  QA_PLANNER_AGENT,
  compileDirectShardPlan,
  createInitialQaShardRunState,
  qaShardPlanPath,
  qaShardStatePath,
  readQaShardRunState,
  shouldUsePlannerForShardPlan,
  updateQaShardRunState,
  buildQaShardPlannerTask,
  registerQaShardPlannerRun,
  submitQaShardPlanToolInput,
  writeQaShardPlan,
  writeQaShardRunState
} from '../shards.ts'
import {
  buildQaShardWorkerTask,
  createQaShardRunSpec,
  prepareQaShardWorker,
  registerQaShardWorkerRun
} from '../worker.ts'
import {
  appendEvidence,
  bindActiveRunContext,
  clearActiveRun,
  compileFreehandRunSpec,
  compileMissionRunSpec,
  compileStagedRunSpec,
  computeQaFinish,
  getActiveRun,
  getCurrentRunId,
  getEvidence,
  getSteps,
  parseMissionSections,
  recordAcceptedPlan,
  recordQaStep,
  registerActiveRun,
  renderRunSpec,
  validateQaMissionSource,
  validateQaPlan,
  validateQaStep,
  type AcceptedQaPlan,
  type QaFinishInput,
  type QaPlanInput,
  type QaRunSpec,
  type QaStepInput
} from '../run-state.ts'

interface CheckResult { readonly name: string; readonly ok: boolean; readonly detail?: string }
const results: CheckResult[] = []

await check('mission parser reads frontmatter slug/title and body', () => {
  withWorkspace((root) => {
    write(root, 'src/routes/login.qa.md', `---\nslug: login-smoke\ntitle: Login Smoke\n---\n\n# Mission\n\nCheck the login page.`)
    const missions = discoverQaMissions(root)
    assert(missions.length === 1, `expected 1 mission, got ${missions.length}`)
    assert(missions[0]?.slug === 'login-smoke', 'frontmatter slug not parsed')
    assert(missions[0]?.title === 'Login Smoke', 'frontmatter title not parsed')
    assert(missions[0]?.body.includes('Check the login page.'), 'body not parsed')
  })
})

await check('mission parser accepts plain .qa.md with filename slug', () => {
  withWorkspace((root) => {
    write(root, 'src/routes/login.qa.md', '# Login QA\n\nCheck the login page.')
    const missions = discoverQaMissions(root)
    assert(missions.length === 1, `expected 1 mission, got ${missions.length}`)
    assert(missions[0]?.slug === 'login', `expected filename slug, got ${missions[0]?.slug}`)
    assert(missions[0]?.title === undefined, 'plain mission should not invent title')
    assert(missions[0]?.body.includes('Check the login page.'), 'plain body not parsed')
  })
})

await check('mission lookup uses exact slug only and reports missing partials', () => {
  withWorkspace((root) => {
    write(root, 'src/a.qa.md', `---\nslug: exact-smoke\n---\n\nA`)
    assert(lookupQaMission(root, 'exact-smoke').kind === 'found', 'exact slug should resolve')
    assert(lookupQaMission(root, 'exact').kind === 'missing', 'partial slug must not resolve')
    assert(lookupQaMission(root, 'missing').available.length === 1, 'missing lookup should include available missions')
  })
})

await check('staged context returns staged files and diff without using nearby .qa.md', async () => {
  await withWorkspaceAsync(async (root) => {
    git(root, 'init')
    write(root, 'root.qa.md', `---\nslug: root\n---\n\nRoot`)
    write(root, 'src/feature/feature.qa.md', `---\nslug: feature\n---\n\nFeature`)
    write(root, 'src/feature/deep/component.ts', 'export const value = 1\n')
    git(root, 'add', 'src/feature/deep/component.ts')

    const context = await collectStagedQaContext(fakePi(), fakeCtx(root))
    assert(!context.error, `expected no error, got ${context.error}`)
    assert(context.stagedFiles.includes('src/feature/deep/component.ts'), 'staged file missing')
    assert(typeof context.stagedDiff === 'string' && context.stagedDiff.length > 0, 'staged diff missing')
    assert(!Object.prototype.hasOwnProperty.call(context, 'missions'), '/qa:staged must not return mission data')
  })
})

await check('parseMissionSections extracts structured scenario, setup, checks, evidence, and tags', () => {
  const body = [
    '# Login QA',
    '',
    'Setup:',
    '- App is built and running on localhost',
    '',
    'Scenario: Guest can sign in',
    'Given:',
    '- Visit the login page',
    'When:',
    '- Submit valid synthetic credentials',
    'Then:',
    '- The dashboard heading is visible',
    'Checks:',
    '- Console shows no errors',
    'Evidence required:',
    '- screenshot: dashboard final state',
    '- console: zero errors',
    '',
    'Out of scope:',
    '- Real auth providers',
    '',
    'Tags: smoke, login'
  ].join('\n')
  const sections = parseMissionSections(body)
  assert(sections.setup.length === 1, 'setup missing')
  assert(sections.scenarios.length === 1, 'scenario missing')
  const scenario = sections.scenarios[0]!
  assert(scenario.id === 'S1', `expected scenario id S1, got ${scenario.id}`)
  assert(scenario.title === 'Guest can sign in', `unexpected scenario title: ${scenario.title}`)
  assert(scenario.given.length === 1, 'given missing')
  assert(scenario.when.length === 1, 'when missing')
  assert(scenario.then.length === 1, 'then missing')
  assert(scenario.checks.length === 1, 'checks missing')
  assert(scenario.requiredEvidence.length === 2, 'scenario required evidence missing')
  assert(scenario.requiredEvidence[0]?.type === 'screenshot', 'screenshot evidence type lost')
  assert(sections.outOfScope.length === 1, 'out of scope missing')
  assert(sections.tags.includes('smoke') && sections.tags.includes('login'), 'tags missing')
})

await check('compileMissionRunSpec lifts structured scenarios and aggregates run-level evidence', () => {
  const artifacts = buildQaArtifactPlan('login')
  const spec = compileMissionRunSpec({
    target: 'http://localhost:5173',
    artifacts,
    mission: missionRef({
      slug: 'login',
      title: 'Login',
      relativePath: 'login.qa.md',
      body: [
        'Scenario: Sign in',
        'Given:',
        '- on login page',
        'When:',
        '- submit synthetic creds',
        'Then:',
        '- dashboard heading visible',
        'Checks:',
        '- dashboard heading visible',
        'Evidence required:',
        '- screenshot: dashboard'
      ].join('\n')
    })
  })
  assert(spec.mode === 'mission', 'mode')
  assert(spec.mission?.slug === 'login', 'mission slug missing')
  assert(spec.scenarios.length === 1, 'scenarios missing')
  assert(spec.scenarios[0]?.requiredEvidence[0]?.type === 'screenshot', 'scenario evidence missing')
  assert(spec.scenarios[0]?.requiredEvidence[0]?.scenarioId === 'S1', 'scenario id not stamped')
  assert(spec.requiredEvidence.length === 1, 'run-level evidence not aggregated')
  assert(spec.sourceFiles[0] === 'login.qa.md', 'source files missing mission path')
})

await check('validateQaMissionSource and compileMissionRunSpec reject freeform missions without structured scenarios', () => {
  const body = '- visit page\n- click button\n'
  const invalid = validateQaMissionSource(body)
  assert(invalid.some((entry) => entry.includes('at least one Scenario')), 'freeform mission should need Scenario block')
  let rejected = false
  try {
    compileMissionRunSpec({
      target: 'http://localhost:5173',
      artifacts: buildQaArtifactPlan('freeform'),
      mission: missionRef({ slug: 'freeform', title: 'Freeform', relativePath: 'freeform.qa.md', body })
    })
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('Invalid QA mission')
  }
  assert(rejected, 'compileMissionRunSpec should reject non-deterministic mission source')
})

await check('compileStagedRunSpec works from staged files without ever referencing a mission', () => {
  const artifacts = buildQaArtifactPlan('staged')
  const spec = compileStagedRunSpec({
    target: 'http://localhost:5173',
    artifacts,
    stagedFiles: ['src/checkout/page.tsx']
  })
  assert(spec.mode === 'staged', 'mode')
  assert(spec.mission === undefined, 'staged spec must not reference a mission')
  assert(spec.sourceFiles[0] === 'src/checkout/page.tsx', 'staged file missing from source files')
  assert(spec.scenarios.length === 1, 'expected one provisional scenario')
  assert(renderRunSpec(spec).includes('Staged change verification'), 'rendered spec should label provisional scenario')
})

await check('validateQaPlan accepts a plan that covers every run-spec scenario with concrete steps and required evidence', () => {
  const spec = sampleLoginRunSpec()
  const result = validateQaPlan(spec, {
    runId: spec.runId,
    target: spec.target,
    scenarios: [{
      scenarioId: 'S1',
      title: 'Sign in',
      plannedSteps: [
        'navigate to /login on the localhost target',
        'submit synthetic credentials and wait for the dashboard heading'
      ],
      evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
    }],
    safetyNotes: ['synthetic data only']
  })
  assert(result.accepted, `expected accepted, got missing=${result.missing.join('|')} invalid=${result.invalid.join('|')}`)
  assert(result.acceptedScenarioIds.length === 1 && result.acceptedScenarioIds[0] === 'S1', 'accepted scenarios missing')
})

await check('validateQaPlan rejects non-localhost target and runId mismatch', () => {
  const spec = sampleLoginRunSpec()
  const result = validateQaPlan(spec, basePlan(spec, {
    runId: 'bogus-run-id',
    target: 'https://example.com',
    scenarios: [{
      scenarioId: 'S1', title: 'Sign in',
      plannedSteps: ['navigate to /login on the localhost target', 'submit synthetic credentials'],
      evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
    }]
  }))
  assert(!result.accepted, 'should not accept')
  assert(result.invalid.some((entry) => entry.includes('runId mismatch')), 'expected runId mismatch')
  assert(result.invalid.some((entry) => entry.includes('does not match run-spec target')), 'expected target mismatch')
  assert(result.invalid.some((entry) => entry.includes('not a localhost')), 'expected localhost check')
})

await check('validateQaPlan rejects empty plannedSteps and vague steps', () => {
  const spec = sampleLoginRunSpec()
  const result = validateQaPlan(spec, basePlan(spec, {
    scenarios: [{
      scenarioId: 'S1', title: 'Sign in',
      plannedSteps: ['explore the app', '   '],
      evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
    }]
  }))
  assert(!result.accepted, 'should not accept')
  assert(result.invalid.some((entry) => entry.includes('is vague')), 'expected vague step rejection')
})

await check('validateQaPlan reports missing scenarios and missing required evidence', () => {
  const spec = sampleLoginRunSpec({
    extraScenarioIds: ['S2'],
    extraRequiredEvidence: [{ type: 'console', purpose: 'no errors', scenarioId: 'S1' }]
  })
  const result = validateQaPlan(spec, basePlan(spec, {
    scenarios: [{
      scenarioId: 'S1', title: 'Sign in',
      plannedSteps: ['navigate to /login', 'submit synthetic credentials'],
      evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
    }]
  }))
  assert(!result.accepted, 'should not accept')
  assert(result.missing.some((entry) => entry.includes('S2')), 'expected missing scenario S2')
  assert(result.missing.some((entry) => entry.includes('console')), 'expected missing console evidence')
})

await check('validateQaPlan rejects credential leaks and non-localhost URLs in steps', () => {
  const spec = sampleLoginRunSpec()
  const result = validateQaPlan(spec, basePlan(spec, {
    scenarios: [{
      scenarioId: 'S1', title: 'Sign in',
      plannedSteps: [
        'navigate to https://example.com/login then capture screenshot',
        'submit synthetic credentials with password=hunter2 and continue'
      ],
      evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
    }]
  }))
  assert(!result.accepted, 'should not accept')
  assert(result.invalid.some((entry) => entry.includes('non-localhost URL')), 'expected non-localhost URL rejection')
  assert(result.invalid.some((entry) => entry.includes('credential leak')), 'expected credential leak rejection')
})

await check('validateQaPlan accepts scenarios explicitly marked out of scope with a reason', () => {
  const spec = sampleLoginRunSpec({ extraScenarioIds: ['S2'] })
  const result = validateQaPlan(spec, basePlan(spec, {
    scenarios: [{
      scenarioId: 'S1', title: 'Sign in',
      plannedSteps: ['navigate to /login', 'submit synthetic credentials and wait for dashboard'],
      evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
    }],
    outOfScope: [{ scenarioId: 'S2', reason: 'feature flag disabled in this build' }]
  }))
  assert(result.accepted, `expected accepted with out-of-scope, got missing=${result.missing.join('|')} invalid=${result.invalid.join('|')}`)
})

await check('registerActiveRun + recordAcceptedPlan wires plan into the active run registry', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const result = validateQaPlan(spec, basePlan(spec, {
      scenarios: [{
        scenarioId: 'S1', title: 'Sign in',
        plannedSteps: ['navigate to /login', 'submit synthetic credentials and confirm dashboard heading'],
        evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
      }]
    }))
    assert(result.accepted, 'plan should be accepted')
    const plan: AcceptedQaPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: result.acceptedScenarioIds,
      scenarios: [], outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    recordAcceptedPlan(spec.runId, plan)
    const active = getActiveRun(spec.runId)
    assert(active?.acceptedPlan?.runId === spec.runId, 'accepted plan not recorded in registry')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('qa_plan tool binds the calling context to its explicit run id', async () => {
  const specA = { ...sampleLoginRunSpec(), runId: 'run-a', relativeRunDir: '.sworm/qa/login/run-a', relativeArtifactDir: '.sworm/qa/login/run-a/artifacts' }
  const specB = { ...sampleLoginRunSpec(), runId: 'run-b', relativeRunDir: '.sworm/qa/login/run-b', relativeArtifactDir: '.sworm/qa/login/run-b/artifacts' }
  const pi = fakeToolPi()
  const ctxA = { cwd: '/tmp', ui: { notify() {} } }
  registerQaTools(pi as never)
  registerActiveRun(specA)
  registerActiveRun(specB)
  try {
    await pi.tools.qa_plan!.execute('plan-a', basePlan(specA, {
      scenarios: [{
        scenarioId: 'S1', title: 'Sign in',
        plannedSteps: ['navigate to /login', 'submit synthetic credentials and confirm dashboard heading'],
        evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' }]
      }]
    }), undefined, undefined, ctxA)
    assert(getCurrentRunId() === specB.runId, 'legacy current run should remain latest registered run')
    assert(getCurrentRunId(ctxA) === specA.runId, 'qa_plan should bind ctxA to run-a')
  } finally {
    clearActiveRun(specA.runId)
    clearActiveRun(specB.runId)
  }
})

await check('mapPlaywrightToolToEvidenceType maps known Playwright tools and skips unrelated tools', () => {
  assert(mapPlaywrightToolToEvidenceType('playwright_browser_snapshot') === 'accessibility_snapshot', 'snapshot mapping')
  assert(mapPlaywrightToolToEvidenceType('playwright_browser_take_screenshot') === 'screenshot', 'screenshot mapping')
  assert(mapPlaywrightToolToEvidenceType('playwright_browser_console_messages') === 'console', 'console mapping')
  assert(mapPlaywrightToolToEvidenceType('playwright_browser_network_requests') === 'network', 'network mapping')
  assert(mapPlaywrightToolToEvidenceType('playwright_browser_navigate') === 'observation', 'navigate observation mapping')
  assert(mapPlaywrightToolToEvidenceType('qa_plan') === undefined, 'qa_plan must not map to evidence')
  assert(mapPlaywrightToolToEvidenceType('Bash') === undefined, 'Bash must not map to evidence')
})

await check('sanitizeSummary truncates long text and redacts credential leaks', () => {
  const long = 'x'.repeat(3000)
  const trimmed = sanitizeSummary(long)
  assert(trimmed.endsWith('…'), 'long summary should be truncated with marker')
  assert(trimmed.length <= 2001, `summary length ${trimmed.length} exceeds cap`)
  assert(sanitizeSummary('password=hunter2 stays public') === '[redacted: credential-looking content removed]', 'credential leak not redacted')
})

await check('extractScreenshotArtifactPath accepts paths inside the workspace and rejects escapes', () => {
  withWorkspace((root) => {
    const safe = extractScreenshotArtifactPath({ filename: '.sworm/qa/checkout/run-1/artifacts/E1.png' }, root)
    assert(safe?.endsWith('.sworm/qa/checkout/run-1/artifacts/E1.png'), `safe path resolved unexpectedly: ${safe}`)
    const escape = extractScreenshotArtifactPath({ filename: '../escape/E1.png' }, root)
    assert(escape === undefined, 'escape path should not be accepted')
    const missing = extractScreenshotArtifactPath({}, root)
    assert(missing === undefined, 'missing filename should yield undefined')
  })
})

await check('summarizePlaywrightArgs produces structured one-line summaries per tool', () => {
  const nav = summarizePlaywrightArgs('playwright_browser_navigate', { url: 'http://localhost:5173/login' })
  assert(nav.includes('url=http://localhost:5173/login'), 'navigate summary should include URL')
  const click = summarizePlaywrightArgs('playwright_browser_click', { element: 'Submit button' })
  assert(click.includes('element=Submit button'), 'click summary should include element')
  const screenshot = summarizePlaywrightArgs('playwright_browser_take_screenshot', { filename: 'E1.png', fullPage: true })
  assert(screenshot.includes('filename=E1.png') && screenshot.includes('fullPage=true'), 'screenshot summary should include filename and fullPage')
})

await check('beginCapture + finishCapture record screenshot evidence with sequential E# ids and workspace-safe paths', () => {
  withWorkspace((root) => {
    const spec = sampleLoginRunSpec()
    registerActiveRun(spec)
    try {
      const screenshotBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
      const staleRequestedPath = path.join(root, '.sworm/qa/login/run-test-1/artifacts/custom-shot.png')
      mkdirSync(path.dirname(staleRequestedPath), { recursive: true })
      writeFileSync(staleRequestedPath, '')
      const begin = beginCapture({ toolName: 'playwright_browser_take_screenshot', toolCallId: 'call-1', args: { filename: '.sworm/qa/login/run-test-1/artifacts/custom-shot.png' } }, root)
      assert(begin, 'beginCapture should return capture for screenshot tool')
      const record = finishCapture(begin!.pending, { isError: false, result: { content: [{ type: 'text', text: 'screenshot saved' }, { type: 'image', data: screenshotBytes, mimeType: 'image/png' }] } })
      assert(record?.id === 'E1', `expected E1 id, got ${record?.id}`)
      assert(record?.type === 'screenshot', 'evidence type should be screenshot')
      assert(record?.sourceTool === 'playwright_browser_take_screenshot', 'sourceTool missing')
      assert(record?.artifactPaths.length === 1 && record?.artifactPaths[0]?.includes('artifacts/E1.png'), 'Pi-owned artifact path not captured')
      assert(record?.artifactPaths[0] && readFileSync(record.artifactPaths[0]).length > 0, 'screenshot image payload not persisted')
      assert(!existsSync(staleRequestedPath), 'stale tool-written screenshot path should be removed after Pi-owned persistence')
      assert(record?.summary.includes('screenshot saved'), 'summary should include tool text result')
      assert(record?.isError === false, 'isError flag wrong')
      const second = finishCapture(beginCapture({ toolName: 'playwright_browser_snapshot', toolCallId: 'call-2', args: {} }, root)!.pending, { isError: false, result: { content: [{ type: 'text', text: 'page snapshot' }] } })
      assert(second?.id === 'E2', `expected E2, got ${second?.id}`)
      assert(second?.type === 'accessibility_snapshot', 'snapshot evidence type wrong')
      assert(getEvidence(spec.runId).length === 2, 'expected 2 evidence records in registry')
    } finally {
      clearActiveRun(spec.runId)
    }
  })
})

await check('beginCapture skips screenshot path that escapes the workspace', () => {
  withWorkspace((root) => {
    const spec = sampleLoginRunSpec()
    registerActiveRun(spec)
    try {
      const begin = beginCapture({ toolName: 'playwright_browser_take_screenshot', toolCallId: 'call-1', args: { filename: '../outside/E1.png' } }, root)
      assert(begin?.pending.artifactPaths.length === 0, 'unsafe filename should yield no artifact path')
      const record = finishCapture(begin!.pending, { isError: false, result: { content: [] } })
      assert(record?.artifactPaths.length === 0, 'unsafe filename should leave artifactPaths empty')
    } finally {
      clearActiveRun(spec.runId)
    }
  })
})

await check('beginCapture ignores tool events when no QA run is active', () => {
  withWorkspace((root) => {
    const begin = beginCapture({ toolName: 'playwright_browser_snapshot', toolCallId: 'call-1', args: {} }, root)
    assert(begin === undefined, 'no active run should produce no capture')
    assert(getCurrentRunId() === undefined, 'no current run id when nothing is active')
  })
})

await check('beginCapture prefers run id bound to the tool context over global current run', () => {
  withWorkspace((root) => {
    const specA = { ...sampleLoginRunSpec(), runId: 'run-a', relativeRunDir: '.sworm/qa/login/run-a', relativeArtifactDir: '.sworm/qa/login/run-a/artifacts' }
    const specB = { ...sampleLoginRunSpec(), runId: 'run-b', relativeRunDir: '.sworm/qa/login/run-b', relativeArtifactDir: '.sworm/qa/login/run-b/artifacts' }
    const ctxA = {}
    const ctxB = {}
    registerActiveRun(specA)
    registerActiveRun(specB)
    try {
      bindActiveRunContext(ctxA, specA.runId)
      bindActiveRunContext(ctxB, specB.runId)
      assert(getCurrentRunId() === specB.runId, 'latest registered run should remain legacy current run')
      assert(getCurrentRunId(ctxA) === specA.runId, 'ctxA should resolve run-a')
      assert(getCurrentRunId(ctxB) === specB.runId, 'ctxB should resolve run-b')
      const captureA = beginCapture({ toolName: 'playwright_browser_snapshot', toolCallId: 'call-a', args: {} }, root, ctxA)
      const captureB = beginCapture({ toolName: 'playwright_browser_snapshot', toolCallId: 'call-b', args: {} }, root, ctxB)
      assert(captureA?.pending.runId === specA.runId, 'capture should use ctxA run id')
      assert(captureB?.pending.runId === specB.runId, 'capture should use ctxB run id')
    } finally {
      clearActiveRun(specA.runId)
      clearActiveRun(specB.runId)
    }
  })
})

await check('finishCapture records error result with isError=true and sanitized summary', () => {
  withWorkspace((root) => {
    const spec = sampleLoginRunSpec()
    registerActiveRun(spec)
    try {
      const begin = beginCapture({ toolName: 'playwright_browser_navigate', toolCallId: 'call-1', args: { url: 'http://localhost:5173/login' } }, root)!
      const record = finishCapture(begin.pending, { isError: true, result: { content: [{ type: 'text', text: 'password=hunter2 leaked into result' }] } })
      assert(record?.isError === true, 'isError should propagate')
      assert(record?.summary === '[redacted: credential-looking content removed]', 'credential-looking result must be redacted')
    } finally {
      clearActiveRun(spec.runId)
    }
  })
})

await check('appendEvidence assigns E1/E2/E3 in order on the active run', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const first = appendEvidence(spec.runId, baseEvidence({ type: 'observation', sourceTool: 'playwright_browser_navigate', summary: 'navigated' }))
    const second = appendEvidence(spec.runId, baseEvidence({ type: 'screenshot', sourceTool: 'playwright_browser_take_screenshot', summary: 'screenshot' }))
    const third = appendEvidence(spec.runId, baseEvidence({ type: 'console', sourceTool: 'playwright_browser_console_messages', summary: 'no errors' }))
    assert(first?.id === 'E1' && second?.id === 'E2' && third?.id === 'E3', `expected E1/E2/E3, got ${first?.id}/${second?.id}/${third?.id}`)
    assert(getEvidence(spec.runId).length === 3, 'evidence list length wrong')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('validateQaStep rejects pass/fail steps without expected, observed, or evidence ids', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Sign in', plannedSteps: ['x', 'y'], evidenceToCollect: [] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    appendEvidence(spec.runId, baseEvidence({ type: 'screenshot', sourceTool: 'playwright_browser_take_screenshot', summary: 'dashboard' }))
    const empty = validateQaStep(run, { runId: spec.runId, scenarioId: 'S1', title: 'login pass', status: 'pass', expected: [], observed: [], evidenceIds: [] })
    assert(!empty.accepted, 'empty step should be rejected')
    assert(empty.invalid.some((entry) => entry.includes('expected')), 'missing expected not reported')
    assert(empty.invalid.some((entry) => entry.includes('observed')), 'missing observed not reported')
    assert(empty.invalid.some((entry) => entry.includes('evidence id')), 'missing evidence id not reported')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('validateQaStep rejects unknown evidence ids and unknown scenarioId', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Sign in', plannedSteps: ['x', 'y'], evidenceToCollect: [] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    appendEvidence(spec.runId, baseEvidence({ type: 'screenshot' }))
    const bogus = validateQaStep(run, { runId: spec.runId, scenarioId: 'S999', title: 't', status: 'pass', expected: ['e'], observed: ['o'], evidenceIds: ['EZ'] })
    assert(!bogus.accepted, 'unknown scenario/evidence should be rejected')
    assert(bogus.invalid.some((entry) => entry.includes('not in the run spec')), 'scenarioId rejection missing')
    assert(bogus.invalid.some((entry) => entry.includes('EZ')), 'evidence id rejection missing')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('validateQaStep accepts an evidence-backed pass and recordQaStep stores it', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Sign in', plannedSteps: ['x', 'y'], evidenceToCollect: [] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    appendEvidence(spec.runId, baseEvidence({ type: 'screenshot' }))
    const input: QaStepInput = {
      runId: spec.runId, scenarioId: 'S1', title: 'Dashboard heading visible after sign in',
      status: 'pass', expected: ['heading visible'], observed: ['heading was visible'], evidenceIds: ['E1']
    }
    const validation = validateQaStep(run, input)
    assert(validation.accepted, `expected accepted, got ${validation.invalid.join('|')}`)
    const record = recordQaStep(run, input)
    assert(record.scenarioId === 'S1' && record.status === 'pass', 'record values wrong')
    assert(getSteps(spec.runId).length === 1, 'step not persisted in registry')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('computeQaFinish returns pass only when plan, evidence, coverage, and required evidence all clear', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Sign in', plannedSteps: ['x', 'y'], evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state' }] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    appendEvidence(spec.runId, baseEvidence({ type: 'screenshot', artifactPaths: ['/tmp/E1.png'] }))
    recordQaStep(run, { runId: spec.runId, scenarioId: 'S1', title: 'Sign in works', status: 'pass', expected: ['heading'], observed: ['heading'], evidenceIds: ['E1'] })
    const finish = computeQaFinish(run, baseFinish(spec))
    assert(finish.status === 'pass', `expected pass, got ${finish.status} (blockers: ${finish.blockers.join('|')})`)
    assert(finish.coverage[0]?.status === 'planned-tested', `expected planned-tested coverage, got ${finish.coverage[0]?.status}`)
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('computeQaFinish returns inconclusive when there is no accepted plan or no evidence', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    const finish = computeQaFinish(run, baseFinish(spec))
    assert(finish.status === 'inconclusive', 'no plan + no evidence should be inconclusive')
    assert(finish.blockers.some((entry) => entry.includes('no accepted qa_plan')), 'plan blocker missing')
    assert(finish.blockers.some((entry) => entry.includes('no browser evidence')), 'evidence blocker missing')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('computeQaFinish returns fail when a step failed AND a screenshot artifact path exists', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Sign in', plannedSteps: ['x', 'y'], evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state' }] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    appendEvidence(spec.runId, baseEvidence({ type: 'screenshot', artifactPaths: ['/tmp/E1.png'] }))
    recordQaStep(run, { runId: spec.runId, scenarioId: 'S1', title: 'Heading missing', status: 'fail', expected: ['heading'], observed: ['blank'], evidenceIds: ['E1'] })
    const finish = computeQaFinish(run, baseFinish(spec))
    assert(finish.status === 'fail', `expected fail, got ${finish.status}`)
    assert(finish.failures.some((entry) => entry.includes('S1')), 'failure list missing scenario id')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('computeQaFinish downgrades fail to inconclusive when no screenshot evidence has a local path', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Sign in', plannedSteps: ['x', 'y'], evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state' }] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    appendEvidence(spec.runId, baseEvidence({ type: 'screenshot' }))
    recordQaStep(run, { runId: spec.runId, scenarioId: 'S1', title: 'Heading missing', status: 'fail', expected: ['heading'], observed: ['blank'], evidenceIds: ['E1'] })
    const finish = computeQaFinish(run, baseFinish(spec))
    assert(finish.status === 'inconclusive', `expected inconclusive without screenshot path, got ${finish.status}`)
    assert(finish.blockers.some((entry) => entry.includes('screenshot')), 'screenshot artifact path blocker missing')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('computeQaFinish flags bugs without known evidence as failures', () => {
  const spec = sampleLoginRunSpec()
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target: spec.target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Sign in', plannedSteps: ['x', 'y'], evidenceToCollect: [{ type: 'screenshot', purpose: 'dashboard final state' }] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    appendEvidence(spec.runId, baseEvidence({ type: 'screenshot', artifactPaths: ['/tmp/E1.png'] }))
    const finish = computeQaFinish(run, { runId: spec.runId, summary: 'oops', bugs: [{ claim: 'broken submit button', evidenceIds: ['E99'] }] })
    assert(finish.failures.some((entry) => entry.includes('unknown evidence')), 'unknown bug evidence not reported as failure')
  } finally {
    clearActiveRun(spec.runId)
  }
})

await check('summarizeToolResult joins text content parts and notes image attachments', () => {
  assert(summarizeToolResult({ result: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'image' }] } }) === 'one two [image]', 'expected joined text + image marker')
  assert(summarizeToolResult({}) === '', 'missing result should yield empty summary')
})

await check('compileFreehandRunSpec derives scenario title from prompt and never sets a mission', () => {
  const artifacts = buildQaArtifactPlan('freehand')
  const spec = compileFreehandRunSpec({
    target: 'http://localhost:5173',
    artifacts,
    prompt: 'check that the dashboard loads without console errors'
  })
  assert(spec.mode === 'freehand', 'mode')
  assert(spec.mission === undefined, 'freehand spec must not reference a mission')
  assert(spec.scenarios[0]?.title.startsWith('check that the dashboard loads'), 'scenario title should derive from prompt')
})

await check('compileDirectShardPlan creates one mission shard per scenario with scoped evidence', () => {
  const spec = sampleLoginRunSpec({ extraScenarioIds: ['S2'] })
  const plan = compileDirectShardPlan(spec)
  assert(plan.version === 1, 'plan version')
  assert(plan.parentRunId === spec.runId, 'parent run id')
  assert(plan.relativePlanPath === qaShardPlanPath(spec), 'plan path should live under run dir')
  assert(plan.shards.length === 2, `expected 2 shards, got ${plan.shards.length}`)
  assert(plan.shards[0]?.shardId === 'shard-S1', 'stable shard id missing')
  assert(plan.shards[0]?.requiredEvidence.some((entry) => entry.scenarioId === 'S1' && entry.type === 'screenshot'), 'scenario evidence should be scoped')
  assert(plan.shards[1]?.relativeArtifactDir.endsWith('/artifacts/shard-S2'), 'shard artifact dir should be nested below run artifacts')
})

await check('staged and freehand provisional specs request planner while structured mission specs do not', () => {
  const artifacts = buildQaArtifactPlan('staged')
  const staged = compileStagedRunSpec({ target: 'http://localhost:5173', artifacts, stagedFiles: ['src/app.ts'] })
  const freehand = compileFreehandRunSpec({ target: 'http://localhost:5173', artifacts: buildQaArtifactPlan('freehand'), prompt: 'check dashboard' })
  const mission = sampleLoginRunSpec()
  assert(shouldUsePlannerForShardPlan(staged), 'staged provisional spec should use planner')
  assert(shouldUsePlannerForShardPlan(freehand), 'freehand provisional spec should use planner')
  assert(!shouldUsePlannerForShardPlan(mission), 'structured mission spec should not use planner')
})

await check('qa_shard_plan tool submission writes normalized transient shard plan and state', () => {
  withWorkspace((root) => {
    const spec = compileFreehandRunSpec({ target: 'http://localhost:5173', artifacts: buildQaArtifactPlan('freehand'), prompt: 'check dashboard' })
    registerQaShardPlannerRun({ spec, cwd: root, sourceCommand: 'qa:freehand' })
    const result = submitQaShardPlanToolInput(root, {
      runId: spec.runId,
      shards: [{
        title: 'Dashboard loads',
        given: ['App is running'],
        when: ['Open dashboard'],
        then: ['Dashboard content appears'],
        checks: ['No visible error state'],
        requiredEvidence: [{ type: 'dom', purpose: 'dashboard visible' }],
        safetyNotes: ['Use synthetic data']
      }]
    })
    assert(result.accepted, `expected accepted, got ${result.invalid.join('|')}`)
    const written = JSON.parse(readFileSync(path.join(root, result.planPath!), 'utf8'))
    assert(written.shards.length === 1, 'expected one persisted shard')
    assert(written.shards[0]?.scenarioId === 'S1', 'tool should assign stable scenario id by order')
    assert(written.shards[0]?.requiredEvidence[0]?.type === 'accessibility_snapshot', 'planner evidence should normalize dom to accessibility_snapshot')
    assert(existsSync(path.join(root, result.statePath!)), 'tool should write shard-state.json')
  })
})

await check('qa_shard_plan rejects invalid evidence types with actionable message before writing artifacts', () => {
  withWorkspace((root) => {
    const spec = compileFreehandRunSpec({ target: 'http://localhost:5173', artifacts: buildQaArtifactPlan('freehand'), prompt: 'check dashboard' })
    registerQaShardPlannerRun({ spec, cwd: root, sourceCommand: 'qa:freehand' })
    const result = submitQaShardPlanToolInput(root, {
      runId: spec.runId,
      shards: [{ title: 'Dashboard loads', given: ['App running'], when: ['Open'], then: ['Visible'], checks: ['No error'], requiredEvidence: [{ type: 'video', purpose: 'record flow' }] }]
    })
    assert(!result.accepted, 'invalid evidence type should reject')
    assert(result.invalid.some((entry) => entry.includes('video') && entry.includes('screenshot') && entry.includes('accessibility_snapshot')), 'invalid type should list valid evidence types')
    assert(!existsSync(path.join(root, qaShardPlanPath(spec))), 'rejected tool call should not write shards.json')
  })
})

await check('qa_shard_plan rejects incomplete shard fields before writing artifacts', () => {
  withWorkspace((root) => {
    const spec = compileFreehandRunSpec({ target: 'http://localhost:5173', artifacts: buildQaArtifactPlan('freehand'), prompt: 'check dashboard' })
    registerQaShardPlannerRun({ spec, cwd: root, sourceCommand: 'qa:freehand' })
    const result = submitQaShardPlanToolInput(root, {
      runId: spec.runId,
      shards: [{ title: 'Dashboard loads', given: [], when: ['Open'], then: ['Visible'], checks: ['No error'], requiredEvidence: [] }]
    })
    assert(!result.accepted, 'incomplete shard should reject')
    assert(result.invalid.some((entry) => entry.includes('given')), 'missing given should be reported')
    assert(result.invalid.some((entry) => entry.includes('requiredEvidence')), 'missing evidence should be reported')
    assert(!existsSync(path.join(root, qaShardPlanPath(spec))), 'rejected tool call should not write shards.json')
  })
})

await check('planner task uses qa_shard_plan tool, not chat JSON or temp mission creation', () => {
  const spec = compileStagedRunSpec({ target: 'http://localhost:5173', artifacts: buildQaArtifactPlan('staged'), stagedFiles: ['src/app.ts'] })
  const task = buildQaShardPlannerTask({ spec, context: 'diff --git a/src/app.ts b/src/app.ts', sourceCommand: 'qa:staged', extra: 'focus smoke' })
  assert(QA_PLANNER_AGENT === 'agentic-qa.qa-planner', 'planner agent runtime name should be package-scoped')
  assert(task.includes('Call qa_shard_plan exactly once'), 'planner task should require typed tool submission')
  assert(!task.includes('Return only JSON'), 'planner task must not demand chat JSON')
  assert(task.includes('Do not run browser tools'), 'planner task should forbid browser testing')
  assert(task.includes('Do not create or propose temp .qa.md files'), 'planner task should forbid temp mission files')
  assert(task.includes('Do not write JSON files yourself'), 'planner task should keep artifact writing in code')
  assert(task.includes('focus smoke'), 'planner task should include extra user instructions')
})

await check('writeQaShardPlan persists transient shard plan under run directory', () => {
  withWorkspace((root) => {
    const plan = compileDirectShardPlan(sampleLoginRunSpec())
    const written = writeQaShardPlan(root, plan)
    assert(written.endsWith(plan.relativePlanPath), 'written path should match plan relative path')
    assert(existsSync(written), 'shard plan file should exist')
    const json = JSON.parse(readFileSync(written, 'utf8'))
    assert(json.parentRunId === plan.parentRunId, 'persisted plan should include parent run id')
    assert(Array.isArray(json.shards) && json.shards.length === 1, 'persisted plan should include shards')
  })
})

await check('createInitialQaShardRunState records queued shards with child run ids and artifact paths', () => {
  const plan = compileDirectShardPlan(sampleLoginRunSpec({ extraScenarioIds: ['S2'] }))
  const state = createInitialQaShardRunState(plan, 'qa')
  assert(state.parentRunId === plan.parentRunId, 'parent run id should persist')
  assert(state.target === plan.target, 'target should persist')
  assert(state.sourceCommand === 'qa', 'source command should persist')
  assert(state.shardPlanPath === plan.relativePlanPath, 'shard plan path should persist')
  assert(state.shards.length === 2, 'state should track every shard')
  assert(state.shards.every((shard) => shard.status === 'queued'), 'initial shard status should be queued')
  assert(state.shards[0]?.childRunId === 'run-test-1--shard-S1', 'child run id should be assigned')
  assert(state.shards[0]?.artifactPaths.length === 0, 'initial artifact paths should be empty')
})

await check('write/read QA shard run state persists minimal coordinator state under run directory', () => {
  withWorkspace((root) => {
    const plan = compileDirectShardPlan(sampleLoginRunSpec())
    const state = createInitialQaShardRunState(plan, 'qa')
    const written = writeQaShardRunState(root, state)
    assert(written.endsWith(qaShardStatePath(state)), 'state path should live under run dir')
    assert(existsSync(written), 'state file should exist')
    const reloaded = readQaShardRunState(root, state.relativeRunDir)
    assert(reloaded.parentRunId === state.parentRunId, 'reloaded parent run id should match')
    assert(reloaded.shards[0]?.childRunId === state.shards[0]?.childRunId, 'reloaded child run id should match')
  })
})

await check('updateQaShardRunState records running and terminal shard results without retry metadata', () => {
  const state = createInitialQaShardRunState(compileDirectShardPlan(sampleLoginRunSpec()), 'qa')
  const running = updateQaShardRunState(state, 'shard-S1', { status: 'running', artifactPaths: ['.sworm/qa/login/run-test-1/artifacts/shard-S1/E1.png'] })
  assert(running.shards[0]?.status === 'running', 'status should update to running')
  assert(running.shards[0]?.artifactPaths.length === 1, 'artifact paths should update')
  const passed = updateQaShardRunState(running, 'shard-S1', { status: 'passed', reportPath: '.sworm/qa/login/run-test-1/shard-S1/report.md' })
  assert(passed.shards[0]?.status === 'passed', 'status should update to passed')
  assert(passed.shards[0]?.reportPath?.endsWith('report.md'), 'report path should persist')
  assert(!('lease' in passed.shards[0]!), 'minimal state should not include lease metadata')
})

await check('runQaShardCoordinator defaults to serial execution and records child report status', async () => {
  await withWorkspaceAsync(async (root) => {
    const parent = sampleLoginRunSpec({ extraScenarioIds: ['S2'] })
    const plan = compileDirectShardPlan(parent)
    const state = createInitialQaShardRunState(plan, 'qa')
    const order: string[] = []
    const ctx = fakeCoordinatorCtx(root)
    const result = await runQaShardCoordinator({} as never, ctx as never, {
      parentSpec: parent,
      plan,
      state,
      parallel: { enabled: false, maxConcurrency: 8 },
      async runShardWorker(worker) {
        order.push(worker.shard.shardId)
        writeChildReport(root, worker.childSpec, 'pass')
      }
    })
    assert(order.join(',') === 'shard-S1,shard-S2', `expected serial shard order, got ${order.join(',')}`)
    assert(result.state.shards.every((shard) => shard.status === 'passed'), 'all shards should be marked passed')
    assert(result.completed === 2 && result.blocked === 0, 'result counts should match terminal shards')
    const reloaded = readQaShardRunState(root, state.relativeRunDir)
    assert(reloaded.shards.every((shard) => shard.status === 'passed'), 'state file should persist terminal statuses')
  })
})

await check('runQaShardCoordinator honors extension-configured parallel max concurrency', async () => {
  await withWorkspaceAsync(async (root) => {
    const parent = sampleLoginRunSpec({ extraScenarioIds: ['S2', 'S3'] })
    const plan = compileDirectShardPlan(parent)
    const state = createInitialQaShardRunState(plan, 'qa')
    let active = 0
    let maxActive = 0
    const result = await runQaShardCoordinator({} as never, fakeCoordinatorCtx(root) as never, {
      parentSpec: parent,
      plan,
      state,
      parallel: { enabled: true, maxConcurrency: 2 },
      async runShardWorker(worker) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        writeChildReport(root, worker.childSpec, 'pass')
        active -= 1
      }
    })
    assert(maxActive === 2, `expected max concurrency 2, got ${maxActive}`)
    assert(result.state.shards.every((shard) => shard.status === 'passed'), 'parallel shards should be marked passed')
  })
})

await check('runQaShardCoordinator marks worker errors as blocked without retry metadata and clears child run state', async () => {
  await withWorkspaceAsync(async (root) => {
    const parent = sampleLoginRunSpec()
    const plan = compileDirectShardPlan(parent)
    const state = createInitialQaShardRunState(plan, 'qa')
    const notifications: string[] = []
    const result = await runQaShardCoordinator({} as never, fakeCoordinatorCtx(root, notifications) as never, {
      parentSpec: parent,
      plan,
      state,
      parallel: { enabled: false, maxConcurrency: 1 },
      async runShardWorker(worker) {
        registerActiveRun(worker.childSpec)
        throw new Error('browser unavailable')
      }
    })
    assert(result.state.shards[0]?.status === 'blocked', 'failed worker should mark shard blocked')
    assert(result.blocked === 1, 'blocked count should be 1')
    assert(getActiveRun(state.shards[0]!.childRunId) === undefined, 'blocked child run state should be cleared')
    assert(notifications.some((entry) => entry.includes('browser unavailable')), 'blocking error should be surfaced')
    assert(!('lease' in result.state.shards[0]!), 'coordinator should not add retry/lease metadata')
  })
})

await check('computeAggregateQaFinish passes only when every child shard passed', () => {
  withWorkspace((root) => {
    const parent = sampleLoginRunSpec({ extraScenarioIds: ['S2'] })
    const state = shardStateWithReports(root, parent, ['pass', 'pass'])
    const finish = computeAggregateQaFinish(root, { parentSpec: parent, shardState: state })
    assert(finish.status === 'pass', `expected pass, got ${finish.status}`)
    assert(finish.evidence.map((entry) => entry.id).join(',') === 'E1,E2', 'child evidence ids should be renumbered')
    assert(finish.steps.every((step) => step.runId === parent.runId), 'parent steps should use parent run id')
    assert(finish.steps[1]?.evidenceIds[0] === 'E2', 'step evidence ids should be remapped')
    assert(finish.coverage.every((entry) => entry.status === 'planned-tested'), 'all scenarios should be covered')
  })
})

await check('computeAggregateQaFinish promotes planner shard scenarios into aggregate spec and coverage', () => {
  withWorkspace((root) => {
    const parent = compileFreehandRunSpec({ target: 'http://localhost:5173', artifacts: buildQaArtifactPlan('freehand'), prompt: 'check dashboard and settings' })
    registerQaShardPlannerRun({ spec: parent, cwd: root, sourceCommand: 'qa:freehand' })
    const submit = submitQaShardPlanToolInput(root, {
      runId: parent.runId,
      shards: [
        { scenarioId: 'S1', title: 'Dashboard loads', given: ['App running'], when: ['Open dashboard'], then: ['Dashboard visible'], checks: ['Dashboard visible'], requiredEvidence: [{ type: 'screenshot', purpose: 'dashboard' }] },
        { scenarioId: 'S2', title: 'Settings loads', given: ['App running'], when: ['Open settings'], then: ['Settings visible'], checks: ['Settings visible'], requiredEvidence: [{ type: 'console', purpose: 'no errors' }] }
      ]
    })
    assert(submit.accepted, `planner tool should accept aggregate fixture: ${submit.invalid.join('|')}`)
    const plan = JSON.parse(readFileSync(path.join(root, submit.planPath!), 'utf8'))
    let state = readQaShardRunState(root, parent.relativeRunDir)
    for (const shard of plan.shards) {
      const entry = state.shards.find((candidate) => candidate.shardId === shard.shardId)!
      const prepared = prepareQaShardWorker({ parentSpec: parent, shard, state: entry })
      writeChildReport(root, prepared.childSpec, 'pass')
      state = updateQaShardRunState(state, shard.shardId, {
        status: 'passed',
        reportPath: `${prepared.childSpec.relativeRunDir}/report.md`,
        reportJsonPath: `${prepared.childSpec.relativeRunDir}/report.json`,
        artifactPaths: [path.join(root, prepared.childSpec.relativeArtifactDir, 'E1.png')]
      })
    }
    const finish = computeAggregateQaFinish(root, { parentSpec: parent, shardState: state, shardPlan: plan })
    assert(finish.spec.scenarios.length === 2, 'aggregate spec should include planner scenarios')
    assert(finish.spec.scenarios[1]?.id === 'S2', 'planner-created S2 should be promoted into aggregate spec')
    assert(finish.coverage.some((entry) => entry.scenarioId === 'S2' && entry.status === 'planned-tested'), 'planner-created S2 should appear covered')
    assert(finish.acceptedPlan?.acceptedScenarioIds.includes('S2'), 'accepted scenario ids should include planner-created S2')
  })
})

await check('computeAggregateQaFinish fails on failed child and is inconclusive on blocked child', () => {
  withWorkspace((root) => {
    const parent = sampleLoginRunSpec({ extraScenarioIds: ['S2'] })
    const failed = computeAggregateQaFinish(root, { parentSpec: parent, shardState: shardStateWithReports(root, parent, ['pass', 'fail']) })
    assert(failed.status === 'fail', `expected fail, got ${failed.status}`)
    assert(failed.failures.some((entry) => entry.includes('shard-S2')), 'failed shard should appear in failures')

    const blockedState = updateQaShardRunState(shardStateWithReports(root, parent, ['pass', 'pass']), 'shard-S2', { status: 'blocked' })
    const blocked = computeAggregateQaFinish(root, { parentSpec: parent, shardState: blockedState })
    assert(blocked.status === 'inconclusive', `expected inconclusive, got ${blocked.status}`)
    assert(blocked.blockers.some((entry) => entry.includes('shard-S2 blocked')), 'blocked shard should appear in blockers')
  })
})

await check('writeAggregateQaReport writes parent report.json/report.md from child artifacts', async () => {
  await withWorkspaceAsync(async (root) => {
    const parent = sampleLoginRunSpec()
    const state = shardStateWithReports(root, parent, ['pass'])
    const { finish, artifacts } = await writeAggregateQaReport(root, { parentSpec: parent, shardState: state })
    assert(finish.status === 'pass', 'aggregate finish should pass')
    assert(artifacts.written, 'parent aggregate artifacts should be written')
    assert(existsSync(path.join(root, parent.relativeRunDir, 'report.json')), 'parent report.json should exist')
    assert(existsSync(path.join(root, parent.relativeRunDir, 'report.md')), 'parent report.md should exist')
    assert(existsSync(path.join(root, parent.relativeArtifactDir, 'E1.png')), 'child screenshot should be bundled into parent artifacts')
  })
})

await check('writeAggregateQaReport still writes parent report when a child never calls qa_finish', async () => {
  await withWorkspaceAsync(async (root) => {
    const parent = sampleLoginRunSpec()
    const plan = compileDirectShardPlan(parent)
    const state = updateQaShardRunState(createInitialQaShardRunState(plan, 'qa'), 'shard-S1', { status: 'blocked' })
    const { finish, artifacts } = await writeAggregateQaReport(root, { parentSpec: parent, shardState: state, shardPlan: plan })
    assert(finish.status === 'inconclusive', `expected inconclusive parent, got ${finish.status}`)
    assert(finish.blockers.some((entry) => entry.includes('has no child report')), 'missing child report should be recorded as blocker')
    assert(artifacts.written, `parent report should still be written for blocked child: ${JSON.stringify(artifacts.reasons)}`)
    const reportJsonPath = path.join(root, parent.relativeRunDir, 'report.json')
    assert(existsSync(reportJsonPath), 'parent report.json should exist even without child report')
    const json = JSON.parse(readFileSync(reportJsonPath, 'utf8'))
    assert(json.status === 'inconclusive', 'report.json should record inconclusive status')
    assert(json.blockers.some((entry: string) => entry.includes('has no child report')), 'report.json should explain missing child report')
  })
})

await check('qa commands route browser testing through shard coordinator by default', () => {
  const source = readFileSync(new URL('../commands.ts', import.meta.url), 'utf8')
  assert(source.includes("import { runQaShardCoordinator } from './coordinator.ts'"), 'commands should import shard coordinator')
  assert(source.includes('await coordinateQaShards(pi, ctx'), 'qa commands should coordinate shard workers')
  assert(!source.includes('pi.sendUserMessage(buildMissionPrompt'), '/qa mission must not hand testing prompt to main agent')
  assert(!source.includes('pi.sendUserMessage(buildStagedPrompt'), '/qa:staged must not hand testing prompt to main agent')
  assert(!source.includes('pi.sendUserMessage(buildFreehandPrompt'), '/qa:freehand must not hand testing prompt to main agent')
})

await check('createQaShardRunSpec narrows a parent run to one child shard run', () => {
  const parent = sampleLoginRunSpec({ extraScenarioIds: ['S2'] })
  const plan = compileDirectShardPlan(parent)
  const state = createInitialQaShardRunState(plan, 'qa')
  const child = createQaShardRunSpec(parent, plan.shards[0]!, state.shards[0]!)
  assert(child.runId === 'run-test-1--shard-S1', 'child run id should come from shard state')
  assert(child.scenarios.length === 1, 'child run should contain exactly one scenario')
  assert(child.scenarios[0]?.id === 'S1', 'child scenario id should match shard')
  assert(child.requiredEvidence.every((entry) => entry.scenarioId === 'S1'), 'child evidence should be scoped to shard scenario')
  assert(child.relativeArtifactDir.endsWith('/artifacts/shard-S1'), 'child artifact dir should point at shard artifact dir')
})

await check('single-shard worker task stays small and requires child run QA protocol', () => {
  const parent = sampleLoginRunSpec({ extraScenarioIds: ['S2'] })
  const plan = compileDirectShardPlan(parent)
  const state = createInitialQaShardRunState(plan, 'qa')
  const prepared = prepareQaShardWorker({ parentSpec: parent, shard: plan.shards[0]!, state: state.shards[0]! })
  const task = buildQaShardWorkerTask(prepared)
  assert(task.includes('Parent run id: run-test-1'), 'task should include parent run id')
  assert(task.includes('Child run id: run-test-1--shard-S1'), 'task should include child run id')
  assert(task.includes('Shard id: shard-S1'), 'task should include shard id')
  assert(task.includes('Use child run id run-test-1--shard-S1'), 'task should require child run id for QA tools')
  assert(task.includes('Do not test scenarios outside this shard'), 'task should forbid cross-shard testing')
  assert(!task.includes('Mission instructions:'), 'task should not include whole mission prompt ceremony')
  assert(!task.includes('Staged diff'), 'task should not include staged diff')
})

await check('registerQaShardWorkerRun registers the child run without needing main-agent history', () => {
  const parent = sampleLoginRunSpec()
  const plan = compileDirectShardPlan(parent)
  const state = createInitialQaShardRunState(plan, 'qa')
  const prepared = prepareQaShardWorker({ parentSpec: parent, shard: plan.shards[0]!, state: state.shards[0]! })
  try {
    const child = registerQaShardWorkerRun(prepared)
    assert(getActiveRun(child.runId)?.spec.runId === child.runId, 'child active run should be registered')
    assert(getActiveRun(parent.runId) === undefined, 'parent run need not be active for child worker registration')
  } finally {
    clearActiveRun(prepared.childSpec.runId)
  }
})

await check('qa_mission_create renders canonical .qa.md that /qa can compile', async () => {
  await withWorkspaceAsync(async (root) => {
    const result = await createQaMissionFile(root, {
      path: 'src/login/login.qa.md',
      title: 'Login QA',
      purpose: 'Verify login happy path.',
      setup: ['Dev server running'],
      scenarios: [{
        title: 'Guest can sign in',
        given: ['Login page is open'],
        when: ['Enter synthetic valid credentials', 'Submit form'],
        then: ['Dashboard is visible'],
        checks: ['Dashboard heading is visible'],
        requiredEvidence: [{ type: 'screenshot', purpose: 'Dashboard after login' }, { type: 'dom', purpose: 'Rendered dashboard heading and page structure' }]
      }],
      outOfScope: ['Password reset'],
      tags: ['smoke', 'login']
    })
    assert(result.created, `mission create should pass: ${result.invalid.join('|')}`)
    assert(existsSync(path.join(root, 'src/login/login.qa.md')), 'mission file should be written')
    const body = readFileSync(path.join(root, 'src/login/login.qa.md'), 'utf8')
    assert(validateQaMissionSource(body).length === 0, 'rendered mission should validate')
    const spec = compileMissionRunSpec({
      target: 'http://localhost:5173',
      artifacts: buildQaArtifactPlan('login'),
      mission: missionRef({ slug: 'login', relativePath: 'src/login/login.qa.md', body })
    })
    assert(spec.scenarios.length === 1, 'compiled mission should have one scenario')
    assert(spec.requiredEvidence.length === 2, 'compiled mission should preserve evidence')
    assert(spec.requiredEvidence[1]?.type === 'accessibility_snapshot', 'mission create should normalize dom to accessibility_snapshot')
  })
})

await check('qa_mission_create rejects invalid evidence types with actionable message', async () => {
  await withWorkspaceAsync(async (root) => {
    const result = await createQaMissionFile(root, {
      path: 'bad.qa.md',
      title: 'Bad QA',
      purpose: 'Bad mission',
      scenarios: [{ title: 'Bad evidence', given: ['App running'], when: ['Open app'], then: ['App visible'], checks: ['Visible'], requiredEvidence: [{ type: 'video', purpose: 'record flow' }] }]
    })
    assert(!result.created, 'invalid evidence type should reject')
    assert(result.invalid.some((entry) => entry.includes('video') && entry.includes('screenshot') && entry.includes('accessibility_snapshot')), 'invalid type should list valid evidence types')
  })
})

await check('qa_mission_create rejects incomplete scenarios and path escapes', async () => {
  await withWorkspaceAsync(async (root) => {
    const result = await createQaMissionFile(root, {
      path: '../escape.qa.md',
      title: 'Bad QA',
      purpose: 'Bad mission',
      scenarios: [{ title: 'Incomplete', given: [], when: [], then: [], checks: [], requiredEvidence: [] }]
    })
    assert(!result.created, 'invalid mission should reject')
    assert(result.invalid.some((entry) => entry.includes('workspace-relative')), 'path escape should be reported')
    assert(result.invalid.some((entry) => entry.includes('given')), 'missing given should be reported')
  })
})

await check('qa:new prompt instructs ask_user to keep freeform context open and use qa_mission_create', () => {
  const source = readFileSync(new URL('../commands.ts', import.meta.url), 'utf8')
  assert(source.includes('Treat `/qa:new` arguments as the initial natural-language prompt'), 'qa:new args should be initial prompt')
  assert(source.includes('allowFreeform: true'), 'ask_user must allow freeform text')
  assert(source.includes('allowComment: true'), 'ask_user must allow additional comment text')
  assert(source.includes('answer may be entirely freeform text'), 'missing prompt flow should not force menu choices')
  assert(source.includes('Call qa_mission_create to create the file'), 'qa:new should use typed mission creation tool')
  assert(source.includes('If it rejects, fix the fields from the tool error and resubmit'), 'qa:new should retry from tool errors instead of investigating schema')
  assert(source.includes('Evidence types:'), 'qa:new should surface valid evidence types')
  assert(source.includes('Do not use Write/Edit for `.qa.md` mission files'), 'qa:new should not hand-write mission syntax')
})

await check('qa model restore waits for matching qa_finish run id', async () => {
  const pi = {
    thinking: 'xhigh',
    setThinkingLevel(level: string) { this.thinking = level },
    async setModel() { throw new Error('model restore should be skipped when no model was captured') }
  }
  const notifications: string[] = []
  const ctx = { ui: { notify(message: string) { notifications.push(message) } } }

  deferQaRestoreUntilFinish(pi as never, 'run-a', { command: 'qa', model: undefined, thinking: 'minimal' })
  assert(pi.thinking === 'xhigh', 'restore should not happen when deferred')
  assert(!(await restoreQaConfigForRun(pi as never, ctx as never, 'run-b')), 'wrong run id should not restore')
  assert(pi.thinking === 'xhigh', 'wrong run id restored thinking')
  assert(await restoreQaConfigForRun(pi as never, ctx as never, 'run-a'), 'matching run id should restore')
  assert(pi.thinking === 'minimal', 'matching run id did not restore thinking')
  assert(notifications.includes('/qa config restored'), 'restore notification missing')
  assert(!(await restoreQaConfigForRun(pi as never, ctx as never, 'run-a')), 'restore should be one-shot')
})

await check('qa_finish restores deferred test-run config instead of agent_end', async () => {
  await withWorkspaceAsync(async (root) => {
    const pi = fakeToolPi()
    const notifications: string[] = []
    const ctx = { cwd: root, ui: { notify(message: string) { notifications.push(message) } } }
    const spec = sampleLoginRunSpec()

    registerQaTools(pi as never)
    registerActiveRun(spec)
    deferQaRestoreUntilFinish(pi as never, spec.runId, { command: 'qa', model: undefined, thinking: 'xhigh' })
    pi.thinking = 'minimal'

    assert(pi.thinking === 'minimal', 'agent_end should not restore test-run config before qa_finish')
    await pi.tools.qa_finish!.execute('finish', baseFinish(spec), undefined, undefined, ctx as never)
    assert(pi.thinking === 'xhigh', 'qa_finish should restore command config')
    assert(notifications.includes('/qa config restored'), 'qa_finish restore notification missing')
  })
})

await check('qa model restore lifecycle restores on agent abort and session shutdown', async () => {
  const pi = fakeModelPi()
  registerQaModelRestoreLifecycle(pi as never)
  registerQaModelRestoreLifecycle(pi as never)
  assert(pi.handlers.agent_start.length === 1, 'lifecycle should register agent_start once')
  assert(pi.handlers.session_shutdown.length === 1, 'lifecycle should register session_shutdown once')

  const abortNotifications: string[] = []
  const abortCtx = fakeRestoreCtx(abortNotifications)
  const abortSignal = fakeAbortSignal()
  abortCtx.signal = abortSignal as never
  deferQaRestoreUntilFinish(pi as never, 'run-abort', { command: 'qa', model: undefined, thinking: 'low' })
  await pi.handlers.agent_start[0]!({ type: 'agent_start' }, abortCtx as never)
  await pi.handlers.agent_start[0]!({ type: 'agent_start' }, abortCtx as never)
  assert(abortSignal.adds === 1, 'agent_start should not add duplicate abort listeners for one signal')
  abortSignal.abort()
  await tick()
  assert(pi.thinking === 'low', 'abort should restore pending qa model config')
  assert(abortNotifications.includes('/qa config restored'), 'abort restore notification missing')

  pi.thinking = 'xhigh'
  const shutdownNotifications: string[] = []
  const shutdownCtx = fakeRestoreCtx(shutdownNotifications)
  deferQaRestoreUntilFinish(pi as never, 'run-shutdown', { command: 'qa', model: undefined, thinking: 'minimal' })
  await pi.handlers.session_shutdown[0]!({ type: 'session_shutdown' }, shutdownCtx as never)
  assert(pi.thinking === 'minimal', 'session shutdown should restore pending qa model config')
  assert(shutdownNotifications.includes('/qa config restored'), 'shutdown restore notification missing')
  assert(!(await restoreAllPendingQaConfig(pi as never, shutdownCtx as never)), 'shutdown restore should clear pending state')
})

await check('localhost target enforcement accepts only phase-one local URLs', () => {
  assert(isLocalhostQaTarget('http://localhost:5173/login'), 'localhost should pass')
  assert(isLocalhostQaTarget('http://127.0.0.1:5173'), '127.0.0.1 should pass')
  assert(!isLocalhostQaTarget('https://example.com'), 'remote target should fail')
  assert(!isLocalhostQaTarget('file:///tmp/index.html'), 'non-http target should fail')
})

await check('writeQaFinishArtifacts blocks failed runs that lack a screenshot artifact path, non-localhost targets, and credential leaks', async () => {
  await withWorkspaceAsync(async (root) => {
    assert(isSafeArtifactPath('/tmp/qa-root', '/tmp/qa-root/report.md'), 'safe artifact path rejected')
    assert(!isSafeArtifactPath('/tmp/qa-root', '/tmp/qa-root/../escape/report.md'), 'escaped artifact path accepted')

    const screenshot = createScreenshotFile(root)
    const ok = await buildFinishedFailure({ root, screenshotSource: screenshot })
    const result = await writeQaFinishArtifacts(root, ok)
    assert(result.written && !result.blocked, `expected ok write, got ${JSON.stringify(result.reasons)}`)

    const nonLocal = await buildFinishedFailure({ root, target: 'https://example.com', screenshotSource: screenshot })
    assert((await writeQaFinishArtifacts(root, nonLocal)).blocked, 'non-localhost target should be blocked')

    const credentialLeak = await buildFinishedFailure({ root, summary: 'token: abc123 leaked', screenshotSource: screenshot })
    assert((await writeQaFinishArtifacts(root, credentialLeak)).blocked, 'credential-looking summary should be blocked')

    const forcedFailNoScreenshot = { ...ok, status: 'fail' as const, evidence: [] }
    assert((await writeQaFinishArtifacts(root, forcedFailNoScreenshot)).blocked, 'writer must defensively block a fail-status finish that has no screenshot evidence')
  })
})

await check('writeQaFinishArtifacts rejects screenshot paths outside the workspace and never partial-writes', async () => {
  await withWorkspaceAsync(async (root) => {
    const outside = path.join(tmpdir(), `agentic-qa-outside-${Date.now()}.png`)
    writeFileSync(outside, 'fake png bytes')
    try {
      const safe = createScreenshotFile(root)
      const finish = await buildFinishedFailure({
        root,
        screenshotSource: safe,
        extraScreenshotPaths: [outside]
      })
      const result = await writeQaFinishArtifacts(root, finish)
      assert(result.blocked, 'outside screenshot path not blocked')
      assert(!existsSync(path.join(root, '.sworm', 'qa', finish.spec.slug, finish.spec.runId, 'artifacts', 'E1.png')), 'blocked run copied partial screenshot')
      assert(!result.written, 'blocked outside screenshot wrote report')

    } finally {
      rmSync(outside, { force: true })
    }
  })
})

await check('writeQaFinishArtifacts writes report.json and report.md with summary table, coverage, steps, and renderable screenshots', async () => {
  await withWorkspaceAsync(async (root) => {
    const screenshot = createScreenshotFile(root)
    const finish = await buildFinishedFailure({ root, screenshotSource: screenshot })
    const result = await writeQaFinishArtifacts(root, finish)
    assert(result.written && !result.blocked, `artifact write failed: ${JSON.stringify(result.reasons)}`)
    const expectedRun = path.join(root, finish.spec.relativeRunDir)
    assert(result.reportPath === path.join(expectedRun, 'report.md'), `report path mismatch: ${result.reportPath}`)
    assert(result.reportJsonPath === path.join(expectedRun, 'report.json'), `report.json path mismatch: ${result.reportJsonPath}`)
    assert(result.artifactPaths?.[0] === path.join(expectedRun, 'artifacts', 'E1.png'), 'screenshot not copied into artifacts/E1.png')

    const markdown = readFileSync(result.reportPath!, 'utf8')
    assert(markdown.startsWith(`# QA Report: ${finish.spec.slug}`), 'markdown title missing slug')
    assert(markdown.includes('| Status | Target | Mode | Run ID | Duration |'), 'summary table header missing')
    assert(markdown.includes(`| ${finish.status} | ${finish.spec.target} | ${finish.spec.mode} | ${finish.runId} |`), 'summary table row missing')
    assert(markdown.includes('## Coverage'), 'coverage section missing')
    assert(markdown.includes('## Steps'), 'steps section missing')
    assert(markdown.includes('## Bugs'), 'bugs section missing')
    assert(markdown.includes('## Evidence'), 'evidence section missing')
    assert(markdown.includes('![E1 screenshot](artifacts/E1.png)'), 'screenshot image not rendered via markdown image syntax')
    assert(markdown.includes('## Safety notes'), 'safety notes section missing')
    assert(markdown.includes('## Next steps'), 'next steps section missing')

    const json = JSON.parse(readFileSync(result.reportJsonPath!, 'utf8'))
    assert(json.runId === finish.runId, 'report.json runId mismatch')
    assert(json.status === finish.status, 'report.json status mismatch')
    assert(Array.isArray(json.steps) && json.steps.length >= 1, 'report.json steps missing')
    assert(Array.isArray(json.evidence) && json.evidence[0]?.bundledArtifactPaths?.[0] === 'artifacts/E1.png', 'report.json evidence bundle missing')
    assert(json.spec && json.spec.scenarios && Array.isArray(json.spec.scenarios), 'report.json spec missing')
    assert(typeof json.generatedAt === 'string' && json.generatedAt.length > 0, 'report.json generatedAt missing')
  })
})

await check('writeQaFinishArtifacts accepts a pre-saved screenshot already under the run artifact directory', async () => {
  await withWorkspaceAsync(async (root) => {
    const presaved = '.sworm/qa/preplaced/run-pre/artifacts/E1.png'
    const presavedPath = path.join(root, presaved)
    mkdirSync(path.dirname(presavedPath), { recursive: true })
    writeFileSync(presavedPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    const finish = await buildFinishedFailure({
      root,
      slug: 'preplaced',
      runId: 'run-pre',
      screenshotSource: path.join(root, presaved)
    })
    const result = await writeQaFinishArtifacts(root, finish)
    assert(result.written && !result.blocked, `pre-saved artifact write failed: ${JSON.stringify(result.reasons)}`)
    assert(readFileSync(result.reportPath!, 'utf8').includes('![E1 screenshot](artifacts/E1.png)'), 'pre-saved screenshot image not rendered via markdown image syntax')
  })
})

const failed = results.filter((result) => !result.ok)
for (const result of results) console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.detail ? ' — ' + result.detail : ''))
console.log('Agentic QA validation checks: ' + (results.length - failed.length) + '/' + results.length + ' passed')
if (failed.length > 0) process.exit(1)

function createScreenshotFile(root: string): string {
  const filePath = path.join(root, 'mcp-output', 'E1.png')
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
  return filePath
}

interface BuildFinishedFailureOptions {
  readonly root: string
  readonly slug?: string
  readonly runId?: string
  readonly target?: string
  readonly summary?: string
  readonly screenshotSource?: string
  readonly extraScreenshotPaths?: readonly string[]
  readonly evidenceType?: 'screenshot' | 'observation'
}

async function buildFinishedFailure(options: BuildFinishedFailureOptions) {
  const slug = options.slug ?? 'checkout'
  const runId = options.runId ?? `run-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const target = options.target ?? 'http://localhost:5173'
  const summary = options.summary ?? 'failed safely'
  const spec: QaRunSpec = {
    target,
    mode: 'freehand',
    slug,
    runId,
    relativeRunDir: `.sworm/qa/${slug}/${runId}`,
    relativeArtifactDir: `.sworm/qa/${slug}/${runId}/artifacts`,
    setup: [],
    scenarios: [{ id: 'S1', title: 'Failing scenario', given: [], when: [], then: [], checks: [], requiredEvidence: [] }],
    requiredEvidence: [],
    outOfScope: [],
    sourceFiles: [],
    tags: []
  }
  registerActiveRun(spec)
  try {
    const run = getActiveRun(spec.runId)!
    run.acceptedPlan = {
      runId: spec.runId, target, acceptedScenarioIds: ['S1'],
      scenarios: [{ scenarioId: 'S1', title: 'Failing scenario', plannedSteps: ['navigate', 'observe'], evidenceToCollect: [] }],
      outOfScope: [], safetyNotes: [], acceptedAt: new Date().toISOString()
    }
    const artifactPaths: string[] = []
    if (options.screenshotSource) artifactPaths.push(options.screenshotSource)
    if (options.extraScreenshotPaths) artifactPaths.push(...options.extraScreenshotPaths)
    const type = options.evidenceType ?? 'screenshot'
    appendEvidence(spec.runId, baseEvidence({
      type,
      sourceTool: type === 'screenshot' ? 'playwright_browser_take_screenshot' : 'playwright_browser_snapshot',
      summary: 'observed visible failure',
      artifactPaths
    }))
    recordQaStep(run, { runId: spec.runId, scenarioId: 'S1', title: 'Failing assertion', status: 'fail', expected: ['ok'], observed: ['broken'], evidenceIds: ['E1'] })
    return computeQaFinish(run, { runId: spec.runId, summary, bugs: [], safetyNotes: [], nextSteps: [] })
  } finally {
    clearActiveRun(spec.runId)
  }
}

function withWorkspace(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'agentic-qa-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function withWorkspaceAsync(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'agentic-qa-'))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function fakePi(): QaGitRunner {
  return {
    async exec(command: string, args: string[], options: { cwd?: string } = {}) {
      try {
        return {
          stdout: execFileSync(command, args, { cwd: options.cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }),
          stderr: '',
          code: 0,
          killed: false
        }
      } catch (error) {
        const execError = error as { stdout?: Buffer; stderr?: Buffer; status?: number }
        return {
          stdout: execError.stdout?.toString('utf8') ?? '',
          stderr: execError.stderr?.toString('utf8') ?? String(error),
          code: execError.status ?? 1,
          killed: false
        }
      }
    }
  }
}

function fakeCtx(root: string): QaCommandContext {
  return { cwd: root }
}

function fakeCoordinatorCtx(root: string, notifications: string[] = []) {
  return {
    cwd: root,
    ui: {
      notify(message: string) { notifications.push(message) }
    }
  }
}

function writeChildReport(root: string, spec: QaRunSpec, status: 'pass' | 'fail' | 'inconclusive'): void {
  const scenario = spec.scenarios[0]!
  const now = new Date().toISOString()
  write(root, `${spec.relativeArtifactDir}/E1.png`, 'fake screenshot')
  write(root, `${spec.relativeRunDir}/report.md`, `# ${spec.runId}\n`)
  write(root, `${spec.relativeRunDir}/report.json`, JSON.stringify({
    runId: spec.runId,
    status,
    target: spec.target,
    mode: spec.mode,
    slug: spec.slug,
    summary: `${status} child report`,
    coverage: [{ scenarioId: scenario.id, title: scenario.title, status: 'planned-tested' }],
    missingEvidence: [],
    blockers: status === 'inconclusive' ? ['child inconclusive'] : [],
    failures: status === 'fail' ? ['child failed'] : [],
    spec,
    acceptedPlan: {
      runId: spec.runId,
      target: spec.target,
      acceptedScenarioIds: [scenario.id],
      scenarios: [{ scenarioId: scenario.id, title: scenario.title, plannedSteps: ['open page', 'observe result'], evidenceToCollect: spec.requiredEvidence }],
      outOfScope: [],
      safetyNotes: [],
      acceptedAt: now
    },
    steps: [{
      runId: spec.runId,
      scenarioId: scenario.id,
      title: `${scenario.title} assertion`,
      status: status === 'fail' ? 'fail' : 'pass',
      expected: ['expected state'],
      observed: [status === 'fail' ? 'broken state' : 'expected state'],
      evidenceIds: ['E1'],
      bugs: [],
      recordedAt: now
    }],
    evidence: [{
      id: 'E1',
      type: 'screenshot',
      sourceTool: 'playwright_browser_take_screenshot',
      startedAt: now,
      endedAt: now,
      durationMs: 1,
      inputSummary: '',
      summary: 'screenshot evidence',
      artifactPaths: [path.join(root, spec.relativeArtifactDir, 'E1.png')],
      bundledArtifactPaths: [`${spec.relativeArtifactDir}/E1.png`],
      isError: false
    }],
    bugs: [],
    safetyNotes: [],
    nextSteps: []
  }))
}

function shardStateWithReports(root: string, parent: QaRunSpec, statuses: Array<'pass' | 'fail' | 'inconclusive'>) {
  const plan = compileDirectShardPlan(parent)
  let state = createInitialQaShardRunState(plan, 'qa')
  plan.shards.forEach((shard, index) => {
    const entry = state.shards.find((item) => item.shardId === shard.shardId)!
    const prepared = prepareQaShardWorker({ parentSpec: parent, shard, state: entry })
    const status = statuses[index] ?? 'pass'
    writeChildReport(root, prepared.childSpec, status)
    state = updateQaShardRunState(state, shard.shardId, {
      status: status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : 'inconclusive',
      reportPath: `${prepared.childSpec.relativeRunDir}/report.md`,
      reportJsonPath: `${prepared.childSpec.relativeRunDir}/report.json`,
      artifactPaths: [path.join(root, prepared.childSpec.relativeArtifactDir, 'E1.png')]
    })
  })
  return state
}

function fakeToolPi() {
  return {
    thinking: 'xhigh',
    tools: {} as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>,
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      this.tools[tool.name] = tool
    },
    setThinkingLevel(level: string) { this.thinking = level },
    async setModel() { throw new Error('model restore should be skipped when no model was captured') }
  }
}

function fakeModelPi() {
  return {
    thinking: 'xhigh',
    handlers: {
      agent_start: [] as Array<(event: unknown, ctx: unknown) => Promise<void>>,
      session_shutdown: [] as Array<(event: unknown, ctx: unknown) => Promise<void>>
    },
    on(event: 'agent_start' | 'session_shutdown', handler: (event: unknown, ctx: unknown) => Promise<void>) {
      this.handlers[event].push(handler)
    },
    setThinkingLevel(level: string) { this.thinking = level },
    async setModel() { throw new Error('model restore should be skipped when no model was captured') }
  }
}

function fakeRestoreCtx(notifications: string[]) {
  return {
    signal: undefined as AbortSignal | undefined,
    ui: {
      notify(message: string) { notifications.push(message) }
    }
  }
}

function fakeAbortSignal() {
  const listeners: Array<() => void> = []
  return {
    aborted: false,
    adds: 0,
    addEventListener(_event: 'abort', listener: () => void) {
      this.adds += 1
      listeners.push(listener)
    },
    removeEventListener(_event: 'abort', listener: () => void) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    abort() {
      this.aborted = true
      for (const listener of [...listeners]) listener()
    }
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function baseFinish(spec: QaRunSpec, overrides: Partial<QaFinishInput> = {}): QaFinishInput {
  return {
    runId: spec.runId,
    summary: overrides.summary ?? 'ok',
    bugs: overrides.bugs ?? [],
    safetyNotes: overrides.safetyNotes ?? [],
    nextSteps: overrides.nextSteps ?? []
  }
}

function baseEvidence(overrides: Partial<Omit<import('../run-state.ts').QaEvidenceRecord, 'id'>>): Omit<import('../run-state.ts').QaEvidenceRecord, 'id'> {
  return {
    type: overrides.type ?? 'observation',
    sourceTool: overrides.sourceTool ?? 'tool',
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    endedAt: overrides.endedAt,
    durationMs: overrides.durationMs,
    inputSummary: overrides.inputSummary ?? '',
    summary: overrides.summary ?? '',
    artifactPaths: overrides.artifactPaths ?? [],
    isError: overrides.isError ?? false
  }
}

function sampleLoginRunSpec(opts: { extraScenarioIds?: readonly string[]; extraRequiredEvidence?: readonly { type: 'accessibility_snapshot' | 'screenshot' | 'console' | 'network' | 'observation'; purpose: string; scenarioId?: string }[] } = {}): QaRunSpec {
  const scenarios = [
    {
      id: 'S1', title: 'Sign in', given: [], when: [], then: [], checks: [],
      requiredEvidence: [{ type: 'screenshot' as const, purpose: 'dashboard final state', scenarioId: 'S1' }]
    },
    ...(opts.extraScenarioIds ?? []).map((id) => ({
      id, title: `Scenario ${id}`, given: [], when: [], then: [], checks: [], requiredEvidence: []
    }))
  ]
  return {
    target: 'http://localhost:5173',
    mode: 'mission',
    slug: 'login',
    runId: 'run-test-1',
    relativeRunDir: '.sworm/qa/login/run-test-1',
    relativeArtifactDir: '.sworm/qa/login/run-test-1/artifacts',
    setup: [], scenarios, outOfScope: [], sourceFiles: ['login.qa.md'], tags: [],
    requiredEvidence: [
      { type: 'screenshot', purpose: 'dashboard final state', scenarioId: 'S1' },
      ...(opts.extraRequiredEvidence ?? [])
    ]
  }
}

function basePlan(spec: QaRunSpec, overrides: Partial<QaPlanInput>): QaPlanInput {
  return {
    runId: spec.runId,
    target: spec.target,
    scenarios: [],
    ...overrides
  }
}

function missionRef(values: { slug: string; title?: string; relativePath: string; body: string }): QaMission {
  return {
    slug: values.slug,
    title: values.title,
    filePath: path.join('/tmp', values.relativePath),
    relativePath: values.relativePath,
    body: values.body,
    frontmatter: {}
  }
}

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
