#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isSafeArtifactPath, writeQaArtifacts } from '../artifacts.ts'
import { isLocalhostQaTarget } from '../config.ts'
import { discoverQaMissions, lookupQaMission, selectStagedQaMissions, type QaCommandContext, type QaGitRunner } from '../missions.ts'
import { normalizeQaReport, type QaReportInput } from '../report.ts'

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

await check('staged selection chooses nearest colocated mission before root mission', async () => {
  await withWorkspaceAsync(async (root) => {
    git(root, 'init')
    write(root, 'root.qa.md', `---\nslug: root\n---\n\nRoot`)
    write(root, 'src/feature/feature.qa.md', `---\nslug: feature\n---\n\nFeature`)
    write(root, 'src/feature/deep/component.ts', 'export const value = 1\n')
    git(root, 'add', 'src/feature/deep/component.ts')

    const selection = await selectStagedQaMissions(fakePi(), fakeCtx(root))
    assert(selection.stagedFiles.includes('src/feature/deep/component.ts'), 'staged file missing')
    assert(selection.missions.length === 1, `expected nearest mission only, got ${selection.missions.length}`)
    assert(selection.missions[0]?.slug === 'feature', `expected feature mission, got ${selection.missions[0]?.slug}`)
  })
})

await check('report validation forces unsupported pass/fail/bug claims inconclusive', () => {
  const supported = normalizeQaReport({
    status: 'pass',
    target: 'http://localhost:5173',
    mode: 'freehand',
    summary: 'ok',
    evidence: [{ id: 'E1', type: 'observation', summary: 'observed safely' }],
    checks: [{ status: 'pass', claim: 'heading visible', evidenceIds: ['E1'] }],
    bugs: []
  })
  assert(supported.status === 'pass', 'supported pass should remain pass')

  const unsupported = normalizeQaReport({
    status: 'fail',
    target: 'http://localhost:5173',
    mode: 'freehand',
    summary: 'bad',
    evidence: [{ id: 'E1', type: 'observation', summary: 'observed safely' }],
    checks: [{ status: 'fail', claim: 'missing button', evidenceIds: ['E2'] }],
    bugs: [{ claim: 'button broken' }]
  })
  assert(unsupported.status === 'inconclusive', 'unsupported claims should force inconclusive')
  assert(unsupported.unsupportedClaims.length === 2, 'expected unsupported check and bug diagnostics')
})

await check('localhost target enforcement accepts only phase-one local URLs', () => {
  assert(isLocalhostQaTarget('http://localhost:5173/login'), 'localhost should pass')
  assert(isLocalhostQaTarget('http://127.0.0.1:5173'), '127.0.0.1 should pass')
  assert(!isLocalhostQaTarget('https://example.com'), 'remote target should fail')
  assert(!isLocalhostQaTarget('file:///tmp/index.html'), 'non-http target should fail')
})

await check('artifact gates reject unsafe paths, non-localhost targets, credentials, and missing failure screenshots', async () => {
  await withWorkspaceAsync(async (root) => {
    assert(isSafeArtifactPath('/tmp/qa-root', '/tmp/qa-root/report.md'), 'safe artifact path rejected')
    assert(!isSafeArtifactPath('/tmp/qa-root', '/tmp/qa-root/../escape/report.md'), 'escaped artifact path accepted')

    const screenshot = screenshotArtifact(root)
    const base = failReport([{ id: 'E1', type: 'screenshot', summary: 'safe screenshot', artifactPaths: [screenshot] }])
    assert((await writeQaArtifacts(root, { ...base, target: undefined }, normalizeQaReport(base))).blocked, 'missing target artifact not blocked')
    assert((await writeQaArtifacts(root, { ...base, target: 'https://example.com' }, normalizeQaReport(base))).blocked, 'non-localhost artifact not blocked')
    const credential = { ...base, summary: 'token: abc123' }
    assert((await writeQaArtifacts(root, credential, normalizeQaReport(credential))).blocked, 'credential-looking report not blocked')
    const noScreenshot = failReport([{ id: 'E1', type: 'observation', summary: 'safe observation' }])
    assert((await writeQaArtifacts(root, noScreenshot, normalizeQaReport(noScreenshot))).blocked, 'failed report without screenshot not blocked')
    const noScreenshotPath = failReport([{ id: 'E1', type: 'screenshot', summary: 'safe screenshot' }])
    assert((await writeQaArtifacts(root, noScreenshotPath, normalizeQaReport(noScreenshotPath))).blocked, 'failed report without screenshot artifact not blocked')
  })
})

await check('artifact gates reject screenshot paths outside the workspace without partial writes', async () => {
  await withWorkspaceAsync(async (root) => {
    const outside = path.join(tmpdir(), `agentic-qa-outside-${Date.now()}.png`)
    writeFileSync(outside, 'fake png bytes')
    try {
      const input = failReport([
        { id: 'E1', type: 'screenshot', summary: 'safe screenshot', artifactPaths: [screenshotArtifact(root)] },
        { id: 'E2', type: 'screenshot', summary: 'outside screenshot', artifactPaths: [outside] }
      ])
      const artifacts = await writeQaArtifacts(root, input, normalizeQaReport(input))
      assert(artifacts.blocked, 'outside screenshot path not blocked')
      assert(!isSafeArtifactPath(root, outside), 'outside test path unexpectedly inside workspace')
      assert(!existsSync(path.join(root, '.sworm', 'qa', 'checkout', 'run-1', 'artifacts', 'E1.png')), 'blocked run copied partial screenshot')
      assert(!artifacts.written, 'blocked outside screenshot wrote report')
    } finally {
      rmSync(outside, { force: true })
    }
  })
})

await check('failed localhost report bundles screenshot under project .sworm qa run and inlines it', async () => {
  await withWorkspaceAsync(async (root) => {
    const screenshot = screenshotArtifact(root)
    const input = failReport([{ id: 'E1', type: 'screenshot', summary: 'safe screenshot', artifactPaths: [screenshot] }])
    const artifacts = await writeQaArtifacts(root, input, normalizeQaReport(input))
    const expectedRun = path.join(root, '.sworm', 'qa', 'checkout', 'run-1')
    assert(artifacts.written === true && artifacts.blocked === false, 'artifact write failed')
    assert(artifacts.reportPath === path.join(expectedRun, 'report.md'), 'report path outside project qa run')
    assert(artifacts.evidencePath === path.join(expectedRun, 'evidence.json'), 'evidence path outside project qa run')
    assert(artifacts.artifactPaths?.[0] === path.join(expectedRun, 'artifacts', 'E1.png'), 'screenshot not copied into artifacts folder')
    const report = readFileSync(artifacts.reportPath!, 'utf8')
    assert(report.includes('Status: fail'), 'report content missing')
    assert(report.includes('![E1 screenshot](artifacts/E1.png)'), 'report did not inline screenshot')
  })
})

await check('pre-saved screenshot in qa artifact directory is accepted and inlined', async () => {
  await withWorkspaceAsync(async (root) => {
    write(root, '.sworm/qa/checkout/run-1/artifacts/E1.png', 'fake png bytes')
    const input = failReport([
      { id: 'E1', type: 'screenshot', summary: 'safe screenshot', artifactPaths: ['.sworm/qa/checkout/run-1/artifacts/E1.png'] }
    ])
    const artifacts = await writeQaArtifacts(root, input, normalizeQaReport(input))
    assert(artifacts.written === true && artifacts.blocked === false, 'pre-saved artifact write failed')
    assert(readFileSync(artifacts.reportPath!, 'utf8').includes('![E1 screenshot](artifacts/E1.png)'), 'pre-saved screenshot not inlined')
  })
})

const failed = results.filter((result) => !result.ok)
for (const result of results) console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.detail ? ' — ' + result.detail : ''))
console.log('Agentic QA validation checks: ' + (results.length - failed.length) + '/' + results.length + ' passed')
if (failed.length > 0) process.exit(1)

function failReport(evidence: QaReportInput['evidence']): QaReportInput {
  return {
    status: 'fail',
    target: 'http://localhost:5173',
    mode: 'freehand',
    slug: 'checkout',
    runId: 'run-1',
    summary: 'failed safely',
    evidence,
    checks: [{ status: 'fail', claim: 'visible failure', evidenceIds: ['E1'] }],
    bugs: []
  }
}

function screenshotArtifact(root: string): string {
  write(root, 'mcp-output/E1.png', 'fake png bytes')
  return path.join(root, 'mcp-output', 'E1.png')
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
