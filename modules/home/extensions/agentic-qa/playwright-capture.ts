import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { containsCredentialLeak, isSafeArtifactPath } from './artifacts.ts'
import {
  appendEvidence,
  getActiveRun,
  getCurrentRunId,
  getEvidence,
  registerActiveRunCleanup,
  type QaEvidenceRecord,
  type QaEvidenceType
} from './run-state.ts'

const MAX_SUMMARY_LENGTH = 2000
const REDACTED = '[redacted: credential-looking content removed]'

const PLAYWRIGHT_TOOL_TYPES: Record<string, QaEvidenceType> = {
  playwright_browser_snapshot: 'accessibility_snapshot',
  playwright_browser_take_screenshot: 'screenshot',
  playwright_browser_console_messages: 'console',
  playwright_browser_network_requests: 'network',
  playwright_browser_navigate: 'observation',
  playwright_browser_navigate_back: 'observation',
  playwright_browser_click: 'observation',
  playwright_browser_fill_form: 'observation',
  playwright_browser_type: 'observation',
  playwright_browser_hover: 'observation',
  playwright_browser_press_key: 'observation',
  playwright_browser_select_option: 'observation',
  playwright_browser_evaluate: 'observation',
  playwright_browser_run_code: 'observation',
  playwright_browser_tabs: 'observation',
  playwright_browser_resize: 'observation',
  playwright_browser_drag: 'observation',
  playwright_browser_file_upload: 'observation',
  playwright_browser_wait_for: 'observation',
  playwright_browser_handle_dialog: 'observation'
}

export function mapPlaywrightToolToEvidenceType(toolName: string): QaEvidenceType | undefined {
  return PLAYWRIGHT_TOOL_TYPES[toolName]
}

export function sanitizeSummary(value: string): string {
  const trimmed = (value ?? '').toString()
  const truncated = trimmed.length > MAX_SUMMARY_LENGTH ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH)}…` : trimmed
  return containsCredentialLeak(truncated) ? REDACTED : truncated
}

export function extractPlaywrightOutputPath(args: unknown, cwd: string): string | undefined {
  const filename = readStringField(args, 'filename')
  if (!filename) return undefined
  const resolved = path.isAbsolute(filename) ? filename : path.resolve(cwd, filename)
  if (!isSafeArtifactPath(cwd, resolved)) return undefined
  return resolved
}

export function summarizePlaywrightArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  switch (toolName) {
    case 'playwright_browser_navigate':
    case 'playwright_browser_navigate_back':
      return summaryWith({ url: record.url })
    case 'playwright_browser_take_screenshot':
      return summaryWith({ filename: record.filename, fullPage: record.fullPage, type: record.type })
    case 'playwright_browser_snapshot':
    case 'playwright_browser_console_messages':
    case 'playwright_browser_network_requests':
    case 'playwright_browser_evaluate':
      return summaryWith({ filename: record.filename, filter: record.filter, level: record.level })
    case 'playwright_browser_run_code':
      return summaryWith({ filename: record.filename, code: typeof record.code === 'string' ? `${record.code.length} chars` : undefined })
    case 'playwright_browser_tabs':
      return summaryWith({ action: record.action, index: record.index })
    case 'playwright_browser_resize':
      return summaryWith({ width: record.width, height: record.height })
    case 'playwright_browser_click':
    case 'playwright_browser_hover':
    case 'playwright_browser_press_key':
    case 'playwright_browser_select_option':
      return summaryWith({ element: record.element, key: record.key, values: record.values })
    case 'playwright_browser_fill_form':
      return summaryWith({ fields: Array.isArray(record.fields) ? `${record.fields.length} fields` : undefined })
    case 'playwright_browser_type':
      return summaryWith({ element: record.element })
    default:
      return summaryWith({ element: record.element })
  }
}

interface PendingCapture {
  readonly runId: string
  readonly toolName: string
  readonly type: QaEvidenceType
  readonly startedAt: string
  readonly startedAtMs: number
  readonly cwd: string
  readonly inputSummary: string
  readonly artifactPaths: readonly string[]
  readonly requestedOutputPaths: readonly RequestedOutputPath[]
}

interface RequestedOutputPath {
  readonly path: string
  readonly existedAtStart: boolean
}

const pending = new Map<string, PendingCapture>()

export function registerPlaywrightCapture(pi: ExtensionAPI): void {
  registerActiveRunCleanup(clearPendingCapturesForRun)

  pi.on('tool_execution_start', async (event, ctx) => {
    const capture = beginCapture(event, ctx?.cwd ?? process.cwd(), ctx)
    if (!capture) return
    pending.set(capture.toolCallId, capture.pending)
  })

  pi.on('tool_result', async (event) => {
    const callId = readToolCallId(event)
    if (!callId) return
    const capture = pending.get(callId)
    if (!capture) return
    pending.delete(callId)
    const record = await finishCapture(capture, event)
    if (!record) return
    return appendQaEvidenceNotice(event, record)
  })
}

export function clearPendingCapturesForRun(runId: string): void {
  for (const [key, capture] of pending) if (capture.runId === runId) pending.delete(key)
}

interface BeginCaptureResult {
  readonly toolCallId: string
  readonly pending: PendingCapture
}

export function beginCapture(event: unknown, cwd: string, ctx?: ExtensionContext | object): BeginCaptureResult | undefined {
  const toolName = readStringField(event, 'toolName')
  if (!toolName) return undefined
  const type = mapPlaywrightToolToEvidenceType(toolName)
  if (!type) return undefined

  const runId = getCurrentRunId(ctx)
  if (!runId || !getActiveRun(runId)) return undefined

  const toolCallId = readToolCallId(event)
  if (!toolCallId) return undefined
  const args = (event as { args?: unknown }).args
  const inputSummary = sanitizeSummary(summarizePlaywrightArgs(toolName, args))
  const artifactPaths: string[] = []
  const requestedOutputPaths: RequestedOutputPath[] = []
  const outputPath = extractPlaywrightOutputPath(args, cwd)
  if (outputPath) {
    requestedOutputPaths.push({ path: outputPath, existedAtStart: existsSync(outputPath) })
    if (toolName === 'playwright_browser_take_screenshot') artifactPaths.push(outputPath)
  }
  const startedAtMs = Date.now()
  return {
    toolCallId,
    pending: {
      runId,
      toolName,
      type,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      cwd,
      inputSummary,
      artifactPaths,
      requestedOutputPaths
    }
  }
}

export async function finishCapture(capture: PendingCapture, event: unknown): Promise<QaEvidenceRecord | undefined> {
  const artifactPaths = capture.type === 'screenshot' ? await persistScreenshotPayload(capture, event) : await cleanupRequestedOutputPaths(capture)
  const endedAtMs = Date.now()
  const summary = sanitizeSummary(summarizeToolResult(event))
  const isError = Boolean((event as { isError?: unknown }).isError)
  return appendEvidence(capture.runId, {
    type: capture.type,
    sourceTool: capture.toolName,
    startedAt: capture.startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - capture.startedAtMs,
    inputSummary: capture.inputSummary,
    summary,
    artifactPaths,
    isError
  })
}

interface ToolResultPatch {
  readonly content: readonly unknown[]
  readonly details?: unknown
  readonly isError?: boolean
}

function appendQaEvidenceNotice(event: unknown, record: QaEvidenceRecord): ToolResultPatch {
  const patch: { content: readonly unknown[]; details?: unknown; isError?: boolean } = {
    content: [
      ...readToolResultContent(event),
      { type: 'text' as const, text: renderQaEvidenceNotice(record) }
    ]
  }
  const details = readToolResultDetails(event)
  if (details !== undefined) patch.details = details
  const isError = readToolResultIsError(event)
  if (isError !== undefined) patch.isError = isError
  return patch
}

function renderQaEvidenceNotice(record: QaEvidenceRecord): string {
  const lines = [`QA evidence captured: ${record.id} ${record.type} from ${record.sourceTool}.`]
  if (record.isError) lines.push(`Errored evidence cannot support pass/fail qa_step assertions.`)
  else lines.push(`Cite ${record.id} in qa_step when this observation supports the assertion.`)
  if (record.artifactPaths.length > 0) lines.push(`Artifact: ${record.artifactPaths.join(', ')}`)
  lines.push('Use qa_evidence_list if you need the current evidence id catalog.')
  return lines.join('\n')
}

function readToolResultContent(event: unknown): readonly unknown[] {
  if (!event || typeof event !== 'object') return []
  const direct = (event as { content?: unknown }).content
  if (Array.isArray(direct)) return direct
  const result = (event as { result?: unknown }).result
  const nested = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined
  return Array.isArray(nested) ? nested : []
}

function readToolResultDetails(event: unknown): unknown {
  if (!event || typeof event !== 'object') return undefined
  const direct = (event as { details?: unknown }).details
  if (direct !== undefined) return direct
  const result = (event as { result?: unknown }).result
  return result && typeof result === 'object' ? (result as { details?: unknown }).details : undefined
}

function readToolResultIsError(event: unknown): boolean | undefined {
  if (!event || typeof event !== 'object') return undefined
  const direct = (event as { isError?: unknown }).isError
  if (typeof direct === 'boolean') return direct
  const result = (event as { result?: unknown }).result
  const nested = result && typeof result === 'object' ? (result as { isError?: unknown }).isError : undefined
  return typeof nested === 'boolean' ? nested : undefined
}

export function summarizeToolResult(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  const result = (event as { result?: unknown }).result
  const content = result && typeof result === 'object' ? (result as { content?: unknown }).content : (event as { content?: unknown }).content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const text = (item as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
      const type = (item as { type?: unknown }).type
      if (type === 'image') parts.push('[image]')
    }
    return parts.join(' ').trim()
  }
  if (typeof content === 'string') return content
  return ''
}

async function persistScreenshotPayload(capture: PendingCapture, event: unknown): Promise<readonly string[]> {
  const image = extractImagePayload(event)
  const run = getActiveRun(capture.runId)
  if (!image || !run) return fallbackScreenshotArtifactPaths(capture, event)

  const nextEvidenceId = `E${getEvidence(capture.runId).length + 1}`
  const extension = screenshotExtension(image.mimeType)
  const target = path.resolve(capture.cwd, run.spec.relativeArtifactDir, `${nextEvidenceId}${extension}`)
  if (!isSafeArtifactPath(capture.cwd, target)) return capture.artifactPaths

  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, Buffer.from(image.data, 'base64'))
  for (const stale of capture.requestedOutputPaths) {
    if (path.resolve(stale.path) !== path.resolve(target)) await removeRequestedOutputPath(capture.cwd, stale)
  }
  return [target]
}

function fallbackScreenshotArtifactPaths(capture: PendingCapture, event: unknown): readonly string[] {
  const paths = [...capture.artifactPaths]
  for (const candidate of extractScreenshotPathsFromText(summarizeToolResult(event), capture.cwd)) paths.push(candidate)
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))]
}

function extractScreenshotPathsFromText(value: string, cwd: string): readonly string[] {
  const paths: string[] = []
  const patterns = [
    /\]\(([^)\s]+\.(?:png|jpe?g|webp))\)/gi,
    /(?:^|\s)(\.playwright-mcp\/[^\s)`'\"]+\.(?:png|jpe?g|webp))/gi
  ]
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const raw = match[1]?.trim()
      if (!raw) continue
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
      if (isSafeArtifactPath(cwd, resolved)) paths.push(resolved)
    }
  }
  return paths
}

async function cleanupRequestedOutputPaths(capture: PendingCapture): Promise<readonly string[]> {
  for (const stale of capture.requestedOutputPaths) await removeRequestedOutputPath(capture.cwd, stale)
  return []
}

async function removeRequestedOutputPath(cwd: string, requested: RequestedOutputPath): Promise<void> {
  if (requested.existedAtStart) return
  if (!isSafeArtifactPath(cwd, requested.path)) return
  await rm(requested.path, { force: true })
}

interface ScreenshotPayload {
  readonly data: string
  readonly mimeType?: string
}

function extractImagePayload(event: unknown): ScreenshotPayload | undefined {
  if (!event || typeof event !== 'object') return undefined
  const result = (event as { result?: unknown }).result
  const content = result && typeof result === 'object' ? (result as { content?: unknown }).content : (event as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const type = (item as { type?: unknown }).type
      const data = (item as { data?: unknown }).data
    const mimeType = (item as { mimeType?: unknown }).mimeType
    if (type === 'image' && typeof data === 'string' && data.trim().length > 0) {
      return { data: data.trim(), ...(typeof mimeType === 'string' ? { mimeType } : {}) }
    }
  }
  return undefined
}

function screenshotExtension(mimeType: string | undefined): string {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/webp') return '.webp'
  return '.png'
}

function readToolCallId(event: unknown): string | undefined {
  const value = (event as { toolCallId?: unknown })?.toolCallId
  return typeof value === 'string' ? value : undefined
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[field]
  return typeof raw === 'string' ? raw : undefined
}

function summaryWith(fields: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  return parts.join(' ')
}
