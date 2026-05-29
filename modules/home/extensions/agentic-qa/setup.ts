import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { runtimeProfileTaskFields, type RuntimeProfile } from '@pi/lib/runtime-profile'
import { fenced } from './markdown.ts'
import { renderRunSpec, type QaRunSpec } from './run-state.ts'

export const QA_SETUP_AGENT = 'agentic-qa.qa-setup'

const PRE_SETUP_TARGET_TIMEOUT_MS = 2_000
const POST_SETUP_TARGET_TIMEOUT_MS = 90_000
const TARGET_POLL_INTERVAL_MS = 500

interface QaTargetProbeResult {
  readonly ok: boolean
  readonly status?: number
  readonly error?: string
}

interface QaTargetWaitOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly signal?: AbortSignal
}

export async function ensureQaEnvironmentReady(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  spec: QaRunSpec,
  label: string,
  runtimeProfile: RuntimeProfile = {}
): Promise<void> {
  const setupItems = actionableQaSetupItems(spec.setup)
  let setupRan = false
  let target = await waitForQaTarget(spec.target, {
    timeoutMs: PRE_SETUP_TARGET_TIMEOUT_MS,
    intervalMs: TARGET_POLL_INTERVAL_MS,
    signal: ctx.signal
  })

  if (!target.ok && setupItems.length > 0) {
    ctx.ui.notify(`${label}: running one-time QA setup.`, 'info')
    await runQaEnvironmentSetupSubagent(pi, ctx, spec, setupItems, label, runtimeProfile)
    setupRan = true
    target = await waitForQaTarget(spec.target, {
      timeoutMs: POST_SETUP_TARGET_TIMEOUT_MS,
      intervalMs: TARGET_POLL_INTERVAL_MS,
      signal: ctx.signal
    })
  }

  if (!target.ok) {
    const suffix = setupRan ? ' after setup' : ''
    const advice = setupItems.length > 0
      ? 'Check the setup instructions or dev-server logs.'
      : 'Start the app first or add mission Setup instructions that start it.'
    throw new Error(
      `${label}: localhost target ${spec.target} is not reachable${suffix}: ${target.error ?? 'request failed'}. ${advice}`
    )
  }
}

export function actionableQaSetupItems(setup: readonly string[]): string[] {
  return setup.map((item) => item.trim()).filter((item) => item && !isNoopSetupItem(item))
}

export async function waitForQaTarget(targetUrl: string, options: QaTargetWaitOptions = {}): Promise<QaTargetProbeResult> {
  const timeoutMs = options.timeoutMs ?? POST_SETUP_TARGET_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? TARGET_POLL_INTERVAL_MS
  const started = Date.now()
  let last: QaTargetProbeResult = { ok: false, error: 'not checked yet' }

  while (Date.now() - started <= timeoutMs) {
    if (options.signal?.aborted) return { ok: false, error: 'aborted' }
    last = await probeQaTarget(targetUrl, { timeoutMs: Math.min(intervalMs, 1_000), signal: options.signal })
    if (last.ok) return last
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - started))), options.signal)
  }

  return { ok: false, error: last.error ? `timed out waiting for target (${last.error})` : 'timed out waiting for target' }
}

async function probeQaTarget(
  targetUrl: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}
): Promise<QaTargetProbeResult> {
  return probeQaTargetWithMethod(targetUrl, 'HEAD', options, true)
}

async function probeQaTargetWithMethod(
  targetUrl: string,
  method: 'HEAD' | 'GET',
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  fallbackToGet: boolean
): Promise<QaTargetProbeResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_000)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(targetUrl, {
      method,
      redirect: 'manual',
      signal: controller.signal
    })
    await response.body?.cancel()
    return { ok: true, status: response.status }
  } catch (error) {
    if (fallbackToGet) return probeQaTargetWithMethod(targetUrl, 'GET', options, false)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function buildQaEnvironmentSetupTask(spec: QaRunSpec, setupItems = actionableQaSetupItems(spec.setup)): string {
  return [
    'Run one-time environment setup for an agentic QA run.',
    '',
    'You are the setup worker, not a browser tester.',
    'Prepare the localhost target once before shard workers launch.',
    `Parent run id: ${spec.runId}`,
    `Target: ${spec.target}`,
    `Run dir: ${spec.relativeRunDir}`,
    '',
    'Setup items:',
    ...setupItems.map((item) => `- ${item}`),
    '',
    'Rules:',
    '- Use built-in shell/file tools only; do not use Playwright or QA report tools.',
    '- If setup requires a dev server, start exactly one server process in the background/detached and leave it running for shard workers.',
    '- Do not start duplicate servers if the target is already reachable.',
    '- Wait until the target URL responds before reporting success.',
    '- Use synthetic/local-only data. Do not expose secrets, cookies, tokens, passwords, or PHI.',
    '- If setup cannot be completed, say SETUP_BLOCKED: <reason>.',
    '- If setup is complete and target is reachable, end with SETUP_OK.',
    spec.workspaceInstructions ? `\n${spec.workspaceInstructions}` : undefined,
    '',
    'Run spec for context:',
    fenced('text', renderRunSpec(spec))
  ].join('\n')
}

async function runQaEnvironmentSetupSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  spec: QaRunSpec,
  setupItems: readonly string[],
  label: string,
  runtimeProfile: RuntimeProfile
): Promise<void> {
  const { extractSubagentText, runSubagent } = await import('@pi/lib/subagents')
  const response = await runSubagent(
    pi,
    ctx,
    {
      tasks: [
        {
          agent: QA_SETUP_AGENT,
          task: buildQaEnvironmentSetupTask(spec, [...setupItems]),
          ...runtimeProfileTaskFields(runtimeProfile)
        }
      ],
      agentScope: 'both'
    },
    `${label} setup`,
    `qa:${spec.runId}:setup`
  )
  const text = extractSubagentText(response).trim()
  const status = parseQaSetupWorkerStatus(text)
  if (status.kind === 'blocked') throw new Error(`${label}: setup blocked: ${status.reason}`)
  if (status.kind === 'malformed') throw new Error(`${label}: setup worker returned malformed status: ${text || 'empty response'}`)
}

export type QaSetupWorkerStatus =
  | { readonly kind: 'ok' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'malformed' }

export function parseQaSetupWorkerStatus(text: string): QaSetupWorkerStatus {
  const finalLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
  if (finalLine === 'SETUP_OK') return { kind: 'ok' }

  const blocked = finalLine.match(/^SETUP_BLOCKED\s*:\s*(.+)$/i)
  if (blocked) return { kind: 'blocked', reason: blocked[1]?.trim() || 'no reason supplied' }

  return { kind: 'malformed' }
}

function isNoopSetupItem(item: string): boolean {
  return /^(none|n\/a|na|not required|no setup|no setup required)$/i.test(item.trim())
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) return
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>
    const abort = () => finish()
    function finish() {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    timeout = setTimeout(finish, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
