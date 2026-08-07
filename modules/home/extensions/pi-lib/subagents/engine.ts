import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { DiscoveredAgent } from './discovery.ts'
import { buildCappedParentFacingText, capRecentOutput, capToolPreview } from './output.ts'
import { parseThinking as parseThinkingLevel } from './request.ts'
import {
  combineSubagentUsage,
  emptySubagentUsage,
  type SubagentDuration,
  type SubagentExecutionEvent,
  type SubagentRunRequest,
  type SubagentRunResult,
  type SubagentRunState,
  type SubagentRunUpdate,
  type SubagentSlotPlan,
  type SubagentSlotResult,
  type SubagentToolSnapshot,
  type SubagentUsage
} from './types.ts'

const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const
const TOOL_ALIASES: Record<string, (typeof BUILTIN_TOOLS)[number]> = {
  read: 'read',
  bash: 'bash',
  edit: 'edit',
  write: 'write',
  grep: 'grep',
  glob: 'find',
  find: 'find',
  ls: 'ls',
  list: 'ls'
}

interface PiRuntimeModule {
  ModelRuntime: {
    create(options?: Record<string, unknown>): Promise<{
      getModel(provider: string, modelId: string): unknown
    }>
  }
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> }
  SessionManager: { inMemory(cwd: string): unknown }
  SettingsManager: { inMemory(): unknown }
  createAgentSession(options: Record<string, unknown>): Promise<{ session: RunnerSession }>
}

let piRuntime: Promise<PiRuntimeModule> | undefined

async function loadPiRuntime(): Promise<PiRuntimeModule> {
  if (!piRuntime) piRuntime = (import('@earendil-works/pi-coding-agent') as Promise<unknown>).then(asPiRuntime)
  return piRuntime
}

function asPiRuntime(value: unknown): PiRuntimeModule {
  if (!value || typeof value !== 'object')
    throw new Error('@earendil-works/pi-coding-agent did not export a module object.')
  const requiredMembers = [
    'ModelRuntime',
    'DefaultResourceLoader',
    'SessionManager',
    'SettingsManager',
    'createAgentSession'
  ] as const
  for (const member of requiredMembers) {
    if (!(member in value)) throw new Error(`@earendil-works/pi-coding-agent missing member: ${member}`)
  }
  return value as PiRuntimeModule
}

type SessionEvent = { type: string; [key: string]: unknown }
type SessionListener = (event: SessionEvent) => void

export interface RunnerSession {
  prompt(task: string): Promise<void>
  subscribe(listener: SessionListener): () => void
  abort(): Promise<void> | void
  dispose(): Promise<void> | void
  setModel?(model: unknown): Promise<void>
  getActiveToolNames?(): string[]
  bindExtensions?(bindings: Record<string, unknown>): Promise<void>
  extensionRunner?: {
    hasHandlers?(eventType: string): boolean
    emit?(event: Record<string, unknown>): Promise<unknown>
  }
}

export interface RunnerSessionFactoryOptions {
  agent: DiscoveredAgent
  cwd: string
  agentDir: string
  tools?: string[]
  signal: AbortSignal
}

export interface RunSubagentsOptions {
  agents: ReadonlyMap<string, DiscoveredAgent> | readonly DiscoveredAgent[]
  agentDir?: string
  sessionFactory?: (options: RunnerSessionFactoryOptions) => Promise<RunnerSession>
  onUpdate?: (update: SubagentRunUpdate) => void
}

export async function runSubagents(
  request: SubagentRunRequest,
  options: RunSubagentsOptions
): Promise<SubagentRunResult> {
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const agentMap = normalizeAgentMap(options.agents)
  const startedAt = Date.now()
  const state: SubagentRunState = {
    id: request.id,
    mode: request.mode,
    status: 'running',
    label: request.label,
    request,
    slots: request.slots.map((slot) => createInitialSlot(slot, startedAt)),
    startedAt,
    updatedAt: startedAt,
    events: [],
    rerun: {
      decision: 'not-needed',
      failedSlotIds: [],
      rerunSlotIds: [],
      continuedWithPartialOutput: false
    }
  }
  options.onUpdate?.({ type: 'run-start', state })

  const childControllers = new Set<AbortController>()
  const cancelChildren = () => {
    for (const controller of childControllers) controller.abort()
  }
  request.parentSignal?.addEventListener('abort', cancelChildren, {
    once: true
  })

  try {
    const results =
      request.mode === 'parallel'
        ? await Promise.all(
            request.slots.map((slot, index) =>
              runSlot(slot, index, request, agentMap, agentDir, childControllers, state, options)
            )
          )
        : request.mode === 'chain'
          ? await runChainSlotsGrouped(request, agentMap, agentDir, childControllers, state, options)
          : await runSlotsSequentially(request, agentMap, agentDir, childControllers, state, options)
    state.slots = results
    state.status = request.parentSignal?.aborted
      ? 'cancelled'
      : results.some((slot) => slot.status === 'failed')
        ? 'failed'
        : results.some((slot) => slot.status === 'cancelled')
          ? 'cancelled'
          : 'completed'
    state.cancelled = state.status === 'cancelled'
    state.error = results.find((slot) => slot.error)?.error
    state.rerun = buildRerunState(results)
    state.endedAt = Date.now()
    state.updatedAt = state.endedAt
    const result = buildRunResult(request, state)
    options.onUpdate?.({ type: 'run-end', result })
    return result
  } finally {
    request.parentSignal?.removeEventListener('abort', cancelChildren)
    childControllers.clear()
  }
}

async function runSlotsSequentially(
  request: SubagentRunRequest,
  agents: Map<string, DiscoveredAgent>,
  agentDir: string,
  childControllers: Set<AbortController>,
  state: SubagentRunState,
  options: RunSubagentsOptions
): Promise<SubagentSlotResult[]> {
  const results: SubagentSlotResult[] = []
  for (let i = 0; i < request.slots.length; i++) {
    if (request.parentSignal?.aborted) {
      results.push(createCancelledSlot(request.slots[i]!, Date.now(), 'Parent run cancelled before slot started.'))
      continue
    }
    results.push(await runSlot(request.slots[i]!, i, request, agents, agentDir, childControllers, state, options))
  }
  return results
}

async function runChainSlotsGrouped(
  request: SubagentRunRequest,
  agents: Map<string, DiscoveredAgent>,
  agentDir: string,
  childControllers: Set<AbortController>,
  state: SubagentRunState,
  options: RunSubagentsOptions
): Promise<SubagentSlotResult[]> {
  const results: SubagentSlotResult[] = new Array(request.slots.length)
  for (let index = 0; index < request.slots.length; ) {
    const groupIndex = request.slots[index]?.groupIndex ?? index
    const group: { slot: SubagentSlotPlan; index: number }[] = []
    while (index < request.slots.length && (request.slots[index]?.groupIndex ?? index) === groupIndex) {
      group.push({ slot: request.slots[index]!, index })
      index++
    }
    if (request.parentSignal?.aborted) {
      for (const item of group) {
        results[item.index] = createCancelledSlot(item.slot, Date.now(), 'Parent run cancelled before slot started.')
      }
      continue
    }
    const groupResults = await Promise.all(
      group.map((item) => runSlot(item.slot, item.index, request, agents, agentDir, childControllers, state, options))
    )
    for (let i = 0; i < group.length; i++) {
      results[group[i]!.index] = groupResults[i]!
    }
  }
  return results
}

async function runSlot(
  plan: SubagentSlotPlan,
  index: number,
  request: SubagentRunRequest,
  agents: Map<string, DiscoveredAgent>,
  agentDir: string,
  childControllers: Set<AbortController>,
  state: SubagentRunState,
  options: RunSubagentsOptions
): Promise<SubagentSlotResult> {
  const agent = agents.get(plan.agent)
  const startedAt = Date.now()
  const slot = createInitialSlot(plan, startedAt)
  slot.status = 'running'
  state.slots[index] = slot
  emitEvent(state, options, {
    timestamp: startedAt,
    slotId: slot.id,
    type: 'slot-start'
  })
  emitEvent(state, options, {
    timestamp: startedAt,
    slotId: slot.id,
    type: 'turn-start',
    turn: 1,
    synthetic: true
  })
  options.onUpdate?.({ type: 'slot-update', runId: request.id, slot })

  if (!agent) return failSlot(slot, `Unknown agent: ${plan.agent}`, state, options)
  const controller = new AbortController()
  childControllers.add(controller)
  const onParentAbort = () => controller.abort()
  request.parentSignal?.addEventListener('abort', onParentAbort, {
    once: true
  })
  let session: RunnerSession | undefined
  let unsubscribe: (() => void) | undefined
  let lastAssistantText = ''

  try {
    if (request.parentSignal?.aborted) throw new Error('Cancelled')
    const effectiveAgent = {
      ...agent,
      model: plan.model ?? agent.model,
      thinking: plan.thinking ?? agent.thinking
    }
    session = await createRunnerSession(
      effectiveAgent,
      request.cwd,
      agentDir,
      controller.signal,
      options.sessionFactory
    )
    validateActiveTools(effectiveAgent, session)
    unsubscribe = session.subscribe((event) => {
      handleSessionEvent(event, slot, state, options)
      if (event.type === 'message_end') {
        const text = textFromMessage(event.message)
        if (text) lastAssistantText = text
      }
    })
    let abortPromise: Promise<unknown> | undefined
    const onAbort = () => {
      try {
        const result = session?.abort()
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          abortPromise = (result as Promise<unknown>).catch((error) => {
            emitEvent(state, options, {
              timestamp: Date.now(),
              slotId: slot.id,
              type: 'error',
              error: `Abort failed: ${error instanceof Error ? error.message : String(error)}`
            })
          })
        }
      } catch (error) {
        emitEvent(state, options, {
          timestamp: Date.now(),
          slotId: slot.id,
          type: 'error',
          error: `Abort failed: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await session.prompt(plan.task)
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
      if (abortPromise) await abortPromise
    }
    if (controller.signal.aborted || request.parentSignal?.aborted) return cancelSlot(slot, state, options)
    slot.output.finalOutput = slot.output.finalOutput || lastAssistantText || slot.output.recentOutput
    slot.status = 'completed'
    finishSlot(slot, state, options)
    return slot
  } catch (error) {
    if (controller.signal.aborted || request.parentSignal?.aborted) return cancelSlot(slot, state, options)
    return failSlot(slot, error instanceof Error ? error.message : String(error), state, options)
  } finally {
    unsubscribe?.()
    try {
      await disposeRunnerSession(session)
    } catch (error) {
      emitEvent(state, options, {
        timestamp: Date.now(),
        slotId: slot.id,
        type: 'error',
        error: `Session cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      })
    }
    request.parentSignal?.removeEventListener('abort', onParentAbort)
    childControllers.delete(controller)
  }
}

async function createRunnerSession(
  agent: DiscoveredAgent,
  cwd: string,
  agentDir: string,
  signal: AbortSignal,
  factory: RunSubagentsOptions['sessionFactory']
): Promise<RunnerSession> {
  const tools = resolveToolNames(agent)
  if (factory) return factory({ agent, cwd, agentDir, tools, signal })
  const pi = await loadPiRuntime()
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json')
  })
  const model = resolveModel(agent, modelRuntime)
  const needsExtensionModel = Boolean(agent.model && !model)
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: needsExtensionModel ? providerExtensionPaths(agent.model!, agentDir) : [],
    noExtensions:
      tools !== undefined && tools.every((tool) => BUILTIN_TOOLS.includes(tool as (typeof BUILTIN_TOOLS)[number])),
    noSkills: agent.inheritSkills === false,
    noContextFiles: agent.inheritProjectContext === false,
    systemPromptOverride: (base: unknown) => (agent.systemPromptMode === 'append' ? base : agent.systemPrompt),
    appendSystemPromptOverride: (base: unknown[]) =>
      agent.systemPromptMode === 'append' ? [...base, agent.systemPrompt] : base
  })
  await loader.reload()
  const created = await pi.createAgentSession({
    cwd,
    agentDir,
    sessionManager: pi.SessionManager.inMemory(cwd),
    settingsManager: needsExtensionModel ? pi.SettingsManager.inMemory() : undefined,
    modelRuntime,
    model,
    thinkingLevel: parseThinking(agent.thinking),
    tools,
    resourceLoader: loader
  })
  try {
    await bindRunnerSessionExtensions(created.session)
    if (needsExtensionModel) {
      const extensionModel = resolveModel(agent, modelRuntime)
      if (!extensionModel) throw new Error(`Unknown model: ${agent.model}`)
      if (!created.session.setModel) throw new Error('Runner session cannot select an extension-provided model')
      await created.session.setModel(extensionModel)
    }
    return created.session
  } catch (error) {
    await disposeRunnerSession(created.session)
    throw error
  }
}

async function bindRunnerSessionExtensions(session: RunnerSession): Promise<void> {
  if (!session.bindExtensions) return
  await session.bindExtensions({})
}

async function disposeRunnerSession(session: RunnerSession | undefined): Promise<void> {
  if (!session) return
  try {
    const runner = session.extensionRunner
    if (runner?.emit && (!runner.hasHandlers || runner.hasHandlers('session_shutdown'))) {
      await runner.emit({
        type: 'session_shutdown',
        reason: 'subagent_dispose'
      })
    }
  } finally {
    await session.dispose()
  }
}

function resolveModel(agent: DiscoveredAgent, modelRuntime: { getModel(provider: string, modelId: string): unknown }) {
  if (!agent.model) return undefined
  const [provider, ...rest] = agent.model.split('/')
  const modelId = rest.join('/')
  return provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined
}

function providerExtensionPaths(model: string, agentDir: string): string[] {
  const separator = model.indexOf('/')
  if (separator <= 0) return []
  const provider = model.slice(0, separator)
  const root = join(agentDir, 'extensions')
  return [
    join(root, provider, 'index.ts'),
    join(root, provider, 'index.js'),
    join(root, `${provider}.ts`),
    join(root, `${provider}.js`)
  ].filter(existsSync)
}

function resolveToolNames(agent: DiscoveredAgent): string[] | undefined {
  if (agent.tools === 'none') return []
  if (agent.tools === 'builtins') return [...BUILTIN_TOOLS]
  if (Array.isArray(agent.tools)) return [...new Set(agent.tools.map(normalizeToolName))]
  return undefined
}

function normalizeToolName(tool: string): string {
  const normalized = TOOL_ALIASES[tool.trim().toLowerCase()]
  return normalized ?? tool
}

function validateActiveTools(agent: DiscoveredAgent, session: RunnerSession): void {
  const expected = resolveToolNames(agent)
  if (!expected || !session.getActiveToolNames) return
  const actual = session.getActiveToolNames()
  const missing = expected.filter((tool) => !actual.includes(tool))
  const extra = actual.filter((tool) => !expected.includes(tool))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Active tool mismatch for ${agent.runtimeName}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`
    )
  }
}

function handleSessionEvent(
  event: SessionEvent,
  slot: SubagentSlotResult,
  state: SubagentRunState,
  options: RunSubagentsOptions
): void {
  if (event.type === 'tool_execution_start') {
    const toolName = String(event.toolName ?? 'tool')
    slot.currentTool = toolName
    slot.toolCount += 1
    slot.tools.push({
      id: String(event.toolCallId ?? `${slot.id}:${slot.toolCount}`),
      name: toolName,
      status: 'running',
      argsSummary: summarizeArgs(event.args),
      startedAt: Date.now()
    })
    emitEvent(state, options, {
      timestamp: Date.now(),
      slotId: slot.id,
      type: 'tool-start',
      tool: slot.tools.at(-1)
    })
  } else if (event.type === 'tool_execution_end') {
    const id = String(event.toolCallId ?? '')
    const tool = slot.tools.find((entry) => entry.id === id) ?? slot.tools.at(-1)
    if (tool) {
      tool.status = event.isError ? 'failed' : 'completed'
      tool.endedAt = Date.now()
      tool.elapsedMs = tool.startedAt ? tool.endedAt - tool.startedAt : undefined
      const preview = capToolPreview(textFromContent((event.result as { content?: unknown } | undefined)?.content))
      tool.preview = preview.text
      tool.previewTruncation = preview.truncation
      tool.error = event.isError ? tool.preview || 'Tool failed' : undefined
    }
    slot.currentTool = undefined
    emitEvent(state, options, {
      timestamp: Date.now(),
      slotId: slot.id,
      type: 'tool-end',
      tool
    })
  } else if (event.type === 'message_update') {
    const delta = textDelta(event.assistantMessageEvent)
    if (delta) {
      const capped = capRecentOutput(slot.output.recentOutput, delta)
      slot.output.recentOutput = capped.text
      slot.output.truncation = capped.truncation
      emitEvent(state, options, {
        timestamp: Date.now(),
        slotId: slot.id,
        type: 'slot-output',
        text: delta
      })
    }
  } else if (event.type === 'message_end') {
    const text = textFromMessage(event.message)
    if (text) {
      slot.output.finalOutput = text
      const capped = capRecentOutput('', text)
      slot.output.recentOutput = capped.text
      slot.output.truncation = capped.truncation
    }
    slot.usage = combineSubagentUsage([slot.usage, usageFromMessage(event.message)])
  }
  state.updatedAt = Date.now()
  options.onUpdate?.({ type: 'slot-update', runId: state.id, slot })
}

function createInitialSlot(plan: SubagentSlotPlan, startedAt: number): SubagentSlotResult {
  return {
    id: plan.id,
    agent: plan.agent,
    task: plan.task,
    status: 'pending',
    model: plan.model,
    thinking: plan.thinking,
    toolCount: 0,
    groupId: plan.groupId,
    groupIndex: plan.groupIndex,
    dependsOnSlotIds: plan.dependsOnSlotIds,
    tools: [],
    usage: emptySubagentUsage(),
    duration: { startedAt, elapsedMs: 0 },
    output: { recentOutput: '' },
    attempt: 1
  }
}

function createCancelledSlot(plan: SubagentSlotPlan, now: number, reason: string): SubagentSlotResult {
  const slot = createInitialSlot(plan, now)
  slot.status = 'cancelled'
  slot.cancelled = true
  slot.error = reason
  slot.duration.endedAt = now
  return slot
}

function failSlot(
  slot: SubagentSlotResult,
  message: string,
  state: SubagentRunState,
  options: RunSubagentsOptions
): SubagentSlotResult {
  slot.status = 'failed'
  slot.error = message
  finishSlot(slot, state, options, 'error', message)
  return slot
}

function cancelSlot(
  slot: SubagentSlotResult,
  state: SubagentRunState,
  options: RunSubagentsOptions
): SubagentSlotResult {
  slot.status = 'cancelled'
  slot.cancelled = true
  slot.error = 'Cancelled'
  finishSlot(slot, state, options, 'cancelled', 'Cancelled')
  return slot
}

function finishSlot(
  slot: SubagentSlotResult,
  state: SubagentRunState,
  options: RunSubagentsOptions,
  type: 'slot-end' | 'error' | 'cancelled' = 'slot-end',
  error?: string
): void {
  const endedAt = Date.now()
  slot.duration.endedAt = endedAt
  slot.duration.elapsedMs = endedAt - slot.duration.startedAt
  emitEvent(state, options, {
    timestamp: endedAt,
    slotId: slot.id,
    type: 'turn-end',
    turn: Math.max(1, slot.usage.turns || 1),
    usage: slot.usage,
    synthetic: true
  })
  emitEvent(state, options, {
    timestamp: endedAt,
    slotId: slot.id,
    type,
    error
  })
  options.onUpdate?.({ type: 'slot-update', runId: state.id, slot })
}

const MAX_EVENT_HISTORY = 500

function emitEvent(state: SubagentRunState, options: RunSubagentsOptions, event: SubagentExecutionEvent): void {
  const last = state.events[state.events.length - 1]
  if (event.type === 'slot-output' && last?.type === 'slot-output' && last.slotId === event.slotId) {
    last.text = `${last.text ?? ''}${event.text ?? ''}`
    last.timestamp = event.timestamp
    options.onUpdate?.({ type: 'event', runId: state.id, event: last })
    return
  }
  state.events.push(event)
  if (state.events.length > MAX_EVENT_HISTORY) state.events.splice(0, state.events.length - MAX_EVENT_HISTORY)
  options.onUpdate?.({ type: 'event', runId: state.id, event })
}

function buildRerunState(slots: readonly SubagentSlotResult[]) {
  const failedSlotIds = slots.filter((slot) => slot.status === 'failed').map((slot) => slot.id)
  return {
    decision: failedSlotIds.length > 0 ? ('pending' as const) : ('not-needed' as const),
    failedSlotIds,
    rerunSlotIds: [],
    continuedWithPartialOutput: false
  }
}

function buildRunResult(request: SubagentRunRequest, state: SubagentRunState): SubagentRunResult {
  const endedAt = state.endedAt ?? Date.now()
  const duration: SubagentDuration = {
    startedAt: state.startedAt,
    endedAt,
    elapsedMs: endedAt - state.startedAt
  }
  const finalText = buildCappedParentFacingText(state.slots)
  return {
    id: state.id,
    mode: state.mode,
    status: state.status,
    label: state.label,
    request: stripRuntimeRequestFields(request),
    slots: state.slots,
    usage: combineSubagentUsage(state.slots.map((slot) => slot.usage)),
    duration,
    events: state.events,
    finalText: finalText.text,
    error: state.error,
    cancelled: state.cancelled,
    rerun: state.rerun,
    truncation: finalText.truncation
  }
}

function stripRuntimeRequestFields(request: SubagentRunRequest): SubagentRunRequest {
  const serializableRequest = { ...request }
  delete serializableRequest.parentSignal
  return serializableRequest
}

function normalizeAgentMap(agents: RunSubagentsOptions['agents']): Map<string, DiscoveredAgent> {
  if (agents instanceof Map) return new Map(agents)
  return new Map(agents.map((agent) => [agent.runtimeName, agent]))
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
  return parseThinkingLevel(value) as ThinkingLevel | undefined
}

function summarizeArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined
  try {
    const json = JSON.stringify(args)
    return json.length > 160 ? `${json.slice(0, 157)}...` : json
  } catch {
    return String(args)
  }
}

function textDelta(event: unknown): string {
  return event && typeof event === 'object' && (event as { type?: unknown }).type === 'text_delta'
    ? String((event as { delta?: unknown }).delta ?? '')
    : ''
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  return textFromContent((message as { content?: unknown }).content)
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .filter(Boolean)
    .join('\n')
    .trim()
}

function usageFromMessage(message: unknown): SubagentUsage {
  if (!message || typeof message !== 'object') return emptySubagentUsage()
  const usage = (
    message as {
      usage?: {
        input?: number
        output?: number
        cacheRead?: number
        cacheWrite?: number
        cost?: { total?: number }
      }
    }
  ).usage
  return {
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    costUsd: usage?.cost?.total ?? 0,
    turns: usage ? 1 : 0
  }
}
