#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { visibleWidth } from '@mariozechner/pi-tui'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCompanion, hatchCompanion, observeCompanion, petCompanion } from '../core/companion.ts'
import { initBuddySchema } from '../db/schema.ts'
import { renderSprite, SPECIES_LIST } from '../core/species.ts'
import { renderBuddyInputSprite, renderBuddyPresenceSprite } from '../ui/render.ts'
import { renderSharePreview } from '../ui/share-preview.ts'
import { resolveBuddyStatePaths } from '../db/paths.ts'
import { buildBuddyContext } from '../prompts.ts'
import { buddyHatch, buddyMode, buddyObserve, buddyStatus } from '../actions.ts'
import { getBuddyDatabase } from '../db/index.ts'
import {
  DETECTOR_SUITE,
  detectUnverifiedHedge,
  getReasoningStatus,
  loadSessionGraph,
  logFinding,
  pruneOldSessions,
  purgeReasoning,
  runGuardPipeline,
  selectFindingDetailed,
  setGuardMode,
  writeClaims
} from '../reasoning/index.ts'

interface CheckResult { readonly name: string; readonly ok: boolean; readonly detail?: string }
const results: CheckResult[] = []

if (process.argv.includes('--fallback-child')) {
  runFallbackChild()
  process.exit(0)
}

check('DB path defaults under ~/.pi/agent/state/buddy', () => {
  const paths = resolveBuddyStatePaths({ homeDir: '/tmp/buddy-home' })
  assert(paths.stateDir === '/tmp/buddy-home/.pi/agent/state/buddy', paths.stateDir)
  assert(paths.dbPath === '/tmp/buddy-home/.pi/agent/state/buddy/buddy.db', paths.dbPath)
})

check('core companion hatch, pet, observe, and prompt context', () => {
  const db = new Database(':memory:')
  initBuddySchema(db)
  assert(getCompanion(db) === null, 'fresh DB should not auto-hatch')
  const hatched = hatchCompanion(db, { name: 'Core', species: 'PiDuck' }).companion
  assert(hatched.name === 'Core', 'hatch name mismatch')
  const petted = petCompanion(db)
  assert(petted.companion.xp > hatched.xp, 'pet should award XP')
  const observed = observeCompanion(db, 'Validation finished', 'both')
  assert(observed.xp.xpGained > 0, 'observe should award XP')
  const storedSeed = db.query('SELECT user_id FROM companions WHERE id = ?').get(hatched.id) as { user_id?: string } | null
  assert(typeof storedSeed?.user_id === 'string' && storedSeed.user_id.startsWith('local:'), 'implicit hatch should store a local random seed, not anon')
  const deterministicA = new Database(':memory:')
  const deterministicB = new Database(':memory:')
  initBuddySchema(deterministicA)
  initBuddySchema(deterministicB)
  const a = hatchCompanion(deterministicA, { userId: 'deterministic-user' }).companion
  const b = hatchCompanion(deterministicB, { userId: 'deterministic-user' }).companion
  assert(a.species === b.species && a.stats.DEBUGGING === b.stats.DEBUGGING, 'explicit userId should keep deterministic traits')
  for (const species of SPECIES_LIST) {
    const companion = hatchCompanion(db, { species, replaceExisting: true }).companion
    const sprite = renderSprite({ ...companion, hat: 'crown' })
    assert(sprite.length >= 5, `${species} sprite too short`)
    assert(!sprite.join('\n').includes('{E}'), `${species} sprite still has eye placeholder`)
  }
  const guarded = setGuardMode(db, true)
  const context = buildBuddyContext(guarded)
  assert(context.includes('Guard mode: on.'), 'prompt context missing guard mode')
  assert(context.includes('Never fabricate claims or edges'), 'prompt context missing no-fabrication guidance')
})

check('reasoning detector suite and unverified hedge detector', () => {
  const db = memoryDb()
  assert(DETECTOR_SUITE.length === 7, 'expected seven detectors')
  assert(DETECTOR_SUITE.some((detector) => detector.name === 'detectUnverifiedHedge'), 'missing detectUnverifiedHedge')
  const sessionId = '2026-05-15:test'
  writeClaims(db, sessionId, [
    { external_id: 'h1', speaker: 'assistant', basis: 'deduction', confidence: 'high', text: 'Probably this invariant holds.' }
  ], [])
  const graph = loadSessionGraph(db, sessionId)
  assert(detectUnverifiedHedge(graph).length === 1, 'hedge detector did not fire')
})

check('guard pipeline writes graph and surfaces at most one finding', () => {
  const db = memoryDb()
  const companion = setGuardMode(db, true)
  const out = runGuardPipeline(db, { companionId: companion.id, cwd: projectRoot(), claims: loadBearingClaims(), edges: loadBearingEdges() }, { now: fixedNow })
  assert(out.writeResult.claimsWritten === 6, 'claims not written')
  assert(out.writeResult.edgesWritten === 4, 'edges not written')
  assert(out.finding?.type === 'load_bearing_vibes', 'expected load_bearing_vibes')
  assert(!Array.isArray(out.finding), 'pipeline must surface one finding, not an array')
  assert(out.sessionId.startsWith('2026-05-15:'), 'session date scope mismatch')
  assert(out.extractionInstruction.includes('Recent claims'), 'missing recent-claims extraction context')
})

check('guard no-fabrication, budget, cooldown, kudos bias, retention, purge, and status', () => {
  const db = memoryDb()
  const companion = setGuardMode(db, true)
  const empty = runGuardPipeline(db, { companionId: companion.id, cwd: projectRoot(), claims: [], edges: [] }, { now: fixedNow })
  assert(empty.finding === null && empty.suppression === 'no_candidates', 'empty graph should not fabricate finding')

  const budget = runGuardPipeline(db, { companionId: companion.id, claims: loadBearingClaims(), edges: loadBearingEdges() }, { detectorBudgetMs: 1, measureDetectorMs: (fn) => ({ value: fn(), ms: 99 }), now: fixedNow })
  assert(budget.finding === null && budget.suppression === 'budget', 'budget suppression failed')

  const candidate = { type: 'load_bearing_vibes' as const, anchor_claim_id: 'same', claim_text: 'same' }
  logFinding(db, companion.id, 'session', 10, candidate)
  const cooldown = selectFindingDetailed(db, companion.id, 11, [candidate])
  assert(cooldown.suppression === 'cooldown', 'cooldown suppression failed')

  for (let seq = 20; seq < 23; seq++) logFinding(db, companion.id, 'session', seq, { type: 'echo_chamber', anchor_claim_id: 'c' + seq, claim_text: 'c' + seq })
  const kudos = selectFindingDetailed(db, companion.id, 23, [
    { type: 'load_bearing_vibes', anchor_claim_id: 'new-caution', claim_text: 'caution' },
    { type: 'well_sourced_load_bearer', anchor_claim_id: 'new-kudos', claim_text: 'kudos' }
  ])
  assert(kudos.finding?.type === 'well_sourced_load_bearer', 'kudos bias failed')

  db.query('INSERT INTO reasoning_claims (id, session_id, speaker, text, basis, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('old', '2020-01-01:stale', 'user', 'stale', 'vibes', 'low', 1)
  assert(pruneOldSessions(db, fixedNow()).claims === 1, 'retention prune failed')

  const status = getReasoningStatus(db, companion.id, true, projectRoot())
  assert(status.guardMode === true, 'reasoning status guard mode mismatch')
  assert(purgeReasoning(db, 'all').claims >= 0, 'purge all should return counts')
})

check('no-auto-hatch and guard fallback action behavior', () => {
  const child = runChild('--fallback-child')
  assert(child.noAutoStatus === true, 'status auto-hatched')
  assert(child.noAutoMode === true, 'mode auto-hatched')
  assert(child.hatchOk === true, 'hatch failed')
  assert(child.guardMode === true, 'guard mode failed')
  assert(child.fallbackObserveOk === true, 'fallback observe failed')
  assert(child.fallbackMarked === true, 'fallback marker missing')
})

check('shared UI store survives duplicate @pi/lib module instances', () => {
  const script = `
    const base = 'file://' + process.cwd() + '/modules/home/extensions/pi-lib/ui/status-store.ts'
    const a = await import(base + '?a=' + Date.now())
    const b = await import(base + '?b=' + Date.now())
    a.publishWidget({ id: 'validation:widget', owner: 'validation', placement: 'footerRight', content: ['ok'] })
    const visible = b.getUiStatusStore().snapshot().widgets.some((entry) => entry.id === 'validation:widget')
    console.log(JSON.stringify({ sameStore: a.uiStatusStore === b.uiStatusStore, visible }))
  `
  const child = Bun.spawnSync({ cmd: [process.execPath, '-e', script], cwd: projectRoot(), stdout: 'pipe', stderr: 'pipe' })
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() || child.stdout.toString())
  const result = JSON.parse(child.stdout.toString()) as { sameStore?: boolean; visible?: boolean }
  assert(result.sameStore === true, 'duplicate module instances do not share uiStatusStore')
  assert(result.visible === true, 'published widget not visible from second module instance')
})

check('UI placement static gates', () => {
  const root = projectRoot()
  const contracts = readFileSync(join(root, 'modules/home/extensions/pi-lib/ui/contracts.ts'), 'utf8')
  const buddyUi = readFileSync(join(root, 'modules/home/extensions/buddy/ui/index.ts'), 'utf8')
  const buddyEvents = readFileSync(join(root, 'modules/home/extensions/buddy/events.ts'), 'utf8')
  const buddyCommandRouter = readFileSync(join(root, 'modules/home/extensions/buddy/command-router.ts'), 'utf8')
  const buddyCommands = readFileSync(join(root, 'modules/home/extensions/buddy/commands.ts'), 'utf8')
  const buddyDialog = readFileSync(join(root, 'modules/home/extensions/buddy/ui/dialog.ts'), 'utf8')
  const buddyRender = readFileSync(join(root, 'modules/home/extensions/buddy/ui/render.ts'), 'utf8')
  const sharePreview = readFileSync(join(root, 'modules/home/extensions/buddy/ui/share-preview.ts'), 'utf8')
  const slabEditor = readFileSync(join(root, 'modules/home/extensions/slab/editor.ts'), 'utf8')
  const slabFooter = readFileSync(join(root, 'modules/home/extensions/slab/index.ts'), 'utf8')
  const footerCompat = readFileSync(join(root, 'modules/home/extensions/pi-lib/ui/footer-compat.ts'), 'utf8')
  assert(contracts.includes('inputRight') && contracts.includes('footerRight'), 'pi-lib placements missing')
  assert(buddyUi.includes("placement: 'inputRight'") && !buddyUi.includes("placement: 'inputFooter'") && !buddyUi.includes("placement: 'footerRight'"), 'Buddy should only own inputRight; name lives in the Pi status row via setStatus')
  assert(buddyCommands.includes('openBuddyDialog') && buddyCommands.includes('getArgumentCompletions'), 'Buddy command missing native dialog/completions')
  assert(buddyDialog.includes('renderDialogHeader') && buddyDialog.includes('renderDialogFooter'), 'Buddy dialog missing shared dialog chrome')
  assert(!buddyRender.includes('new Panel') && !buddyRender.includes('levelBar') && !buddyRender.includes('mood:'), 'Buddy input widget should render only pet art')
  assert(buddyRender.includes('renderSprite') && buddyRender.includes('renderBuddyInputSprite') && !buddyRender.includes('renderBuddyInputFeet'), 'Buddy input widget should render the whole sprite as one unit, no body/feet split')
  assert(!buddyRender.includes('shiftDown: true') && !buddyUi.includes("placement: 'footerRight'"), 'Buddy must not publish footerRight so feet do not move with Pi footer')
  assert(buddyEvents.includes('setStatus') && buddyEvents.includes('refreshBuddyStatus'), 'Buddy name should be exposed through ctx.ui.setStatus')
  assert(buddyCommandRouter.includes('refreshBuddyStatus'), 'Slash command path should refresh Buddy status after each action')
  assert(!sharePreview.includes('renderCard') && sharePreview.includes('joinColumns') && sharePreview.includes('renderStatLine'), 'Buddy share preview should use dossier layout without nested card box')
  assert(sharePreview.includes("theme.fg('success'") && sharePreview.includes("theme.fg('warning'") && sharePreview.includes('wrapText'), 'Buddy share preview should color peak/dump stats and wrap description text')
  assert(slabEditor.includes('inputRight') && !slabEditor.includes('inputFooter') && !slabEditor.includes('inputFooterRight'), 'Slab editor should only manage inputRight; name belongs to Pi status row')
  assert(slabEditor.includes('visibleWidth(line)') && !slabEditor.includes('visibleWidth(stripControls(line))'), 'Slab inputRight width must include visible padding to avoid overflow')
  assert(slabFooter.includes('footerRight'), 'Slab footer missing footerRight handling')
  assert(!footerCompat.includes('visibleWidth(stripControls(cleanRight))') && !footerCompat.includes('visibleWidth(stripControls(cleanLeft))'), 'Footer right layout must preserve spaces when measuring widget widths')
  assert(slabFooter.includes('refreshCommandRegistry()') && slabFooter.includes('recognizedCommands'), 'Slab command registry not refreshed for extension commands')
  assert(!productionBuddySource().some((entry) => entry.text.includes('ctx.ui.set' + 'Footer') || entry.text.includes('ctx.ui.set' + 'EditorComponent')), 'Buddy directly owns Pi footer/editor UI')
})

check('sprite canvas and share header layout stay deterministic', () => {
  const db = new Database(':memory:')
  initBuddySchema(db)
  const companion = hatchCompanion(db, { name: 'Deltaflare', species: 'Data Drake' }).companion
  const dataDrake = { ...companion, hat: 'halo' as const }
  const sprite = renderBuddyPresenceSprite(dataDrake, { includeName: true, shiftDown: false, maxWidth: 80 })
  const widths = sprite.filter((line) => line.trim().length > 0).map((line) => visibleWidth(line))
  assert(new Set(widths).size === 1, `sprite lines must share one canvas width, got ${widths.join(',')}`)

  const input = renderBuddyInputSprite(dataDrake, { maxWidth: 80 })
  assert(input.length >= 4, `input sprite should render hat/body/feet rows as one canvas, got ${input.length}`)
  assert(input[0]?.includes('(') && input[0]?.includes(')'), 'hat should occupy Slab info row')
  assert(input.at(-1)?.includes("'-vvvv-'"), 'feet should remain the last row of the sprite canvas')
  const goose = { ...dataDrake, name: 'Stormwarden', species: 'Goose', hat: 'tophat' as const }
  const gooseInput = renderBuddyInputSprite(goose, { maxWidth: 80 })
  const gooseWidths = gooseInput.map((line) => visibleWidth(line))
  assert(new Set(gooseWidths).size === 1, `Goose sprite canvas should have one shared width, got ${gooseWidths.join(',')}`)
  assert(gooseInput[0]?.trimStart().startsWith('[___]'), 'hat should sit at the top of the canvas')
  assert(gooseInput.at(-1)?.includes('^^^^'), 'feet should sit at the bottom of the canvas')

  const preview = renderSharePreview(dataDrake, 56)
  assert(preview[0]?.includes('happy'), 'share header should move mood to former level slot')
  assert(preview[1]?.includes('lvl ') && preview[1]?.includes('/'), 'share level header should include lvl, bar, and current/needed XP')
  assert(!preview.at(-1)?.includes('happy ·'), 'share description should not duplicate mood footer')
})

check('forbidden archive and cross-client strings absent from production Buddy source', () => {
  const forbidden = ['.' + 'buddy', 'better' + '-sqlite3', '@model' + 'contextprotocol', 'Stdio' + 'ServerTransport', 'buddy' + '://', '.' + 'claude', 'puppe' + 'teer', 'buddy' + '_dream', 'buddy' + '_doctor', 'install' + '.sh']
  const hits = [] as string[]
  for (const entry of productionBuddySource()) for (const literal of forbidden) if (entry.text.includes(literal)) hits.push(entry.relative + ':' + literal)
  assert(hits.length === 0, hits.join(', '))
})

const failed = results.filter((result) => !result.ok)
for (const result of results) console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.detail ? ' — ' + result.detail : ''))
console.log('Buddy validation checks: ' + (results.length - failed.length) + '/' + results.length + ' passed')
if (failed.length > 0) process.exit(1)

function runFallbackChild(): void {
  const beforeStatus = buddyStatus()
  const beforeMode = buddyMode({ guard: 'on' })
  const hatch = buddyHatch({ name: 'Fallback', species: 'PiDuck' })
  const mode = buddyMode({ guard: 'on' })
  const real = getBuddyDatabase().db
  real.exec('DROP TABLE reasoning_claims')
  const fallback = buddyObserve({ summary: 'pipeline should fail but normal observe should survive' })
  console.log(JSON.stringify({
    noAutoStatus: beforeStatus.isError === true,
    noAutoMode: beforeMode.isError === true,
    hatchOk: hatch.isError !== true,
    guardMode: mode.details?.guardMode === true,
    fallbackObserveOk: fallback.isError !== true,
    fallbackMarked: fallback.details?.guard?.fallback === true
  }))
}

function check(name: string, run: () => void): void {
  try { run(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }) }
}

function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail)
}

function memoryDb(): Database {
  const db = new Database(':memory:')
  initBuddySchema(db)
  hatchCompanion(db, { name: 'Reason', species: 'PiDuck' })
  return db
}

function loadBearingClaims() {
  return [
    { external_id: 'c1', speaker: 'user', basis: 'vibes', confidence: 'high', text: 'We can merge without tests.' },
    { external_id: 'c2', speaker: 'assistant', basis: 'deduction', confidence: 'high', text: 'The DB migration changed.' },
    { external_id: 'c3', speaker: 'assistant', basis: 'empirical', confidence: 'high', text: 'Smoke test covered schema init.' },
    { external_id: 'c4', speaker: 'assistant', basis: 'llm_output', confidence: 'medium', text: 'Probably enough validation exists.' },
    { external_id: 'c5', speaker: 'user', basis: 'assumption', confidence: 'medium', text: 'No old callers remain.' },
    { external_id: 'c6', speaker: 'assistant', basis: 'research', confidence: 'high', text: 'Spec asks for seven detectors.' }
  ]
}

function loadBearingEdges() {
  return [
    { from: 'c2', to: 'c1', type: 'supports' },
    { from: 'c3', to: 'c1', type: 'supports' },
    { from: 'c4', to: 'c1', type: 'supports' },
    { from: 'c6', to: 'c1', type: 'depends_on' }
  ]
}

function fixedNow(): number { return Date.parse('2026-05-15T00:00:00.000Z') }

function runChild(arg: string): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'buddy-validation-home-'))
  try {
    const child = Bun.spawnSync({ cmd: [process.execPath, fileURLToPath(import.meta.url), arg], cwd: projectRoot(), env: { ...Bun.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' })
    const stdout = child.stdout.toString().trim()
    if (child.exitCode !== 0) throw new Error(child.stderr.toString() || stdout)
    return JSON.parse(stdout) as Record<string, unknown>
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
}

function productionBuddySource(): Array<{ relative: string; text: string }> {
  const root = projectRoot()
  const buddyDir = join(root, 'modules/home/extensions/buddy')
  const out: Array<{ relative: string; text: string }> = []
  walk(buddyDir, out, root)
  return out.filter((entry) => !entry.relative.includes('/tests/'))
}

function walk(dir: string, out: Array<{ relative: string; text: string }>, root: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out, root)
    else if (entry.name.endsWith('.ts')) out.push({ relative: full.slice(root.length + 1), text: readFileSync(full, 'utf8') })
  }
}

