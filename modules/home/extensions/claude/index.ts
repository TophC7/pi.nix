import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
} from '@earendil-works/pi-ai'
import * as piAi from '@earendil-works/pi-ai'
import { getModels } from '@earendil-works/pi-ai/compat'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { claudeArguments } from './claude-command.js'
import { ClaudeProcess } from './claude-process.js'
import { claudeEffort } from './effort.js'
import {
  extractAllToolResults,
  type McpResult,
} from './extract-tool-results.js'
import { createToolBridge, type ToolBridge } from './mcp-bridge.js'
import { MCP_TOOL_PREFIX } from './mcp-names.js'
import { applyLongContext, buildModels, claudeCodeModelId } from './models.js'
import {
  makePromptStream,
  userMessage,
  type InputContent,
} from './prompt-stream.js'
import { QueryContext } from './query-state.js'
import {
  bootstrapPrompt,
  contextDigest,
  currentPrompt,
  extendContextDigest,
  priorMessages,
  restoredSessionState,
  SESSION_ENTRY_TYPE,
  type ContextDigest,
  type PersistedSessionState,
} from './session-state.js'
import { ClaudeTurn } from './stream-events.js'

const PROVIDER_ID = 'claude'
const RUNTIME_KEY = Symbol.for('claude:runtime-v2')

type SessionBinding = {
  append: (state: PersistedSessionState) => void
  cwd: string
}
type SessionRuntime = {
  active?: QueryContext
  persisted?: PersistedSessionState
  validated?: ContextDigest
  binding?: SessionBinding
}
type ProviderRuntime = {
  activeSessionId?: string
  isolateNextStream: boolean
  sessions: Map<string, SessionRuntime>
}
type Runtime = {
  activeQueries: Set<QueryContext>
}

const globalState = globalThis as Record<symbol, unknown>
const runtime = (globalState[RUNTIME_KEY] as Runtime | undefined) ?? {
  activeQueries: new Set<QueryContext>(),
}
if (!globalState[RUNTIME_KEY]) globalState[RUNTIME_KEY] = runtime

const piAiCompat = piAi as any
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
  typeof piAiCompat.createAssistantMessageEventStream === 'function'
    ? piAiCompat.createAssistantMessageEventStream
    : () => new piAiCompat.AssistantMessageEventStream()

const models = buildModels(getModels('anthropic'))

function streamClaudeCore(
  provider: ProviderRuntime,
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  const stream = newAssistantMessageEventStream()
  const piSessionId = provider.activeSessionId

  const results = toolResults(context)
  const owner = results.length > 0 ? queryForResults(results) : undefined
  if (owner) {
    owner.latestMessages = context.messages
    owner.turn = new ClaudeTurn(model, stream, owner.toolNames)
    void deliverToolResults(owner, results, trailingSteer(context)).catch(
      (error) => owner.turn?.fail(asError(error)),
    )
    return stream
  }
  if (context.messages.at(-1)?.role === 'toolResult') {
    return emptyStream(stream, model)
  }

  const session = piSessionId ? (provider.sessions.get(piSessionId) ?? {}) : {}
  const isolated = provider.isolateNextStream || !session.binding
  provider.isolateNextStream = false
  if (!isolated && piSessionId) {
    session.active?.cleanup?.()
    provider.sessions.set(piSessionId, session)
  }

  const history = priorMessages(context.messages)
  const state = session.persisted
  const candidate =
    !isolated &&
    state !== undefined &&
    !('reset' in state) &&
    state.modelId === model.id &&
    state.messageCount === history.length
  let historyDigest: ContextDigest
  let aligned = false
  if (candidate && !('reset' in state)) {
    const cached = session.validated
    if (
      cached?.messageCount === state.messageCount &&
      cached.contextHash === state.contextHash
    ) {
      historyDigest = cached
      aligned = true
    } else {
      historyDigest = contextDigest(history)
      aligned = historyDigest.contextHash === state.contextHash
      if (aligned) session.validated = historyDigest
    }
  } else {
    historyDigest = contextDigest(history)
  }
  const resume =
    aligned && state && !('reset' in state) ? state.claudeSessionId : undefined
  const prompt =
    aligned || history.length === 0
      ? currentPrompt(context.messages)
      : bootstrapPrompt(context.messages)
  if (prompt.length === 0)
    return failedStream(stream, model, new Error('Claude prompt is empty'))

  const query = new QueryContext()
  query.latestMessages = context.messages
  const { tools, toolNames } = isolated
    ? { tools: [], toolNames: new Map<string, string>() }
    : resolveTools(context)
  query.toolNames = toolNames
  query.turn = new ClaudeTurn(model, stream, toolNames)

  const cwd = session.binding?.cwd ?? process.cwd()
  const input = makePromptStream()
  query.promptStream = input
  const initialPrompt = input.push(userMessage(prompt)).catch(() => undefined)

  let bridge: ToolBridge | undefined
  let claude: ClaudeProcess
  try {
    bridge = createToolBridge(tools, query, 'bun')
    claude = new ClaudeProcess({
      executable: 'claude',
      args: claudeArguments({
        model: claudeCodeModelId(model),
        systemPrompt: context.systemPrompt,
        effort: claudeEffort(options?.reasoning),
        resume,
        mcpConfig: bridge?.mcpConfig,
        persistSession: !isolated,
        maxTurns: isolated ? 1 : undefined,
      }),
      cwd,
      env: transportEnvironment(),
    })
    if (bridge) {
      void bridge.ready
        .then(() => input.attach(claude))
        .catch((error) => input.fail(asError(error)))
    } else {
      input.attach(claude)
    }
    if (isolated) void initialPrompt.finally(() => input.end())
  } catch (error) {
    bridge?.close()
    input.fail(asError(error))
    return failedStream(stream, model, asError(error))
  }

  let aborted = false
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    input.fail(new Error('query ended'))
    for (const pending of query.pendingToolCalls.values()) {
      pending.resolve({ content: [{ type: 'text', text: 'Query ended' }] })
    }
    query.pendingToolCalls.clear()
    query.pendingResults.clear()
    bridge?.close()
    claude.close()
    runtime.activeQueries.delete(query)
    if (!isolated && session.active === query) session.active = undefined
  }
  const abort = () => {
    if (aborted) return
    aborted = true
    void claude.interrupt().catch(() => undefined)
    query.turn?.fail(new Error('Operation aborted'), true)
    cleanup()
  }
  query.cleanup = abort
  if (!isolated) {
    session.active = query
    runtime.activeQueries.add(query)
  }
  if (options?.signal) {
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
  }

  void consume(
    claude,
    input,
    query,
    () => aborted,
    () => {
      if (!isolated && !aborted && piSessionId)
        persistCompletedSession(
          provider,
          piSessionId,
          model,
          query,
          historyDigest,
        )
    },
  )
    .catch((error) => {
      if (!isolated && piSessionId)
        invalidateSession(provider, piSessionId, true)
      query.turn?.fail(asError(error), aborted)
    })
    .finally(() => {
      if (options?.signal) options.signal.removeEventListener('abort', abort)
      cleanup()
    })

  return stream
}

async function consume(
  claude: ClaudeProcess,
  input: ReturnType<typeof makePromptStream>,
  query: QueryContext,
  wasAborted: () => boolean,
  onTerminal: () => void,
): Promise<void> {
  for await (const message of claude) {
    if (wasAborted()) return
    if (typeof message.session_id === 'string')
      query.claudeSessionId = message.session_id
    if (message.type === 'result') input.end()
    const terminal = query.turn?.handle(message) ?? false
    if (terminal) {
      onTerminal()
      return
    }
  }
  if (!wasAborted())
    throw new Error('Claude Code output ended before a terminal result')
}

function persistCompletedSession(
  provider: ProviderRuntime,
  piSessionId: string,
  model: Model<any>,
  query: QueryContext,
  historyDigest: ContextDigest,
): void {
  if (!query.claudeSessionId || !query.turn) return
  const appendedMessages = [
    ...query.latestMessages.slice(historyDigest.messageCount),
    query.turn.message,
  ]
  const digest = extendContextDigest(historyDigest, appendedMessages)
  const state: PersistedSessionState = {
    version: 2,
    claudeSessionId: query.claudeSessionId,
    modelId: model.id,
    ...digest,
  }
  const session = provider.sessions.get(piSessionId) ?? {}
  session.persisted = state
  session.validated = digest
  provider.sessions.set(piSessionId, session)
  session.binding?.append(state)
}

function invalidateSession(
  provider: ProviderRuntime,
  piSessionId: string,
  persistReset: boolean,
): void {
  const session = provider.sessions.get(piSessionId) ?? {}
  session.active?.cleanup?.()
  session.active = undefined
  session.persisted = { version: 2, reset: true }
  session.validated = undefined
  provider.sessions.set(piSessionId, session)
  if (persistReset) session.binding?.append(session.persisted)
}

function bindSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  provider: ProviderRuntime,
): SessionRuntime {
  const piSessionId = ctx.sessionManager.getSessionId()
  const session = provider.sessions.get(piSessionId) ?? {}
  provider.activeSessionId = piSessionId
  session.binding = {
    append: (state) => pi.appendEntry(SESSION_ENTRY_TYPE, state),
    cwd: ctx.cwd,
  }
  session.persisted = restoredSessionState(ctx.sessionManager.getBranch())
  session.validated = undefined
  provider.sessions.set(piSessionId, session)
  return session
}

function resolveTools(context: Context): {
  tools: Tool[]
  toolNames: Map<string, string>
} {
  const tools = context.tools ?? []
  const toolNames = new Map<string, string>()
  for (const tool of tools) {
    const claudeName = `${MCP_TOOL_PREFIX}${tool.name}`
    toolNames.set(claudeName, tool.name)
    toolNames.set(claudeName.toLowerCase(), tool.name)
  }
  return { tools, toolNames }
}

function toolResults(context: Context): McpResult[] {
  return extractAllToolResults(
    context.messages as unknown as Array<{
      role: string
      content?: unknown
      toolCallId?: string
      isError?: boolean
    }>,
  )
}

function queryForResults(results: McpResult[]): QueryContext | undefined {
  for (const result of results) {
    if (!result.toolCallId) continue
    for (const query of runtime.activeQueries) {
      if (
        query.pendingToolCalls.has(result.toolCallId) ||
        query.pendingResults.has(result.toolCallId) ||
        query.turn?.toolCallIds.includes(result.toolCallId)
      ) {
        return query
      }
    }
  }
  return undefined
}

async function deliverToolResults(
  query: QueryContext,
  results: McpResult[],
  steer: InputContent[],
): Promise<void> {
  if (steer.length > 0 && query.promptStream)
    await query.promptStream.push(userMessage(steer, 'next'))
  for (const result of results) {
    const id = result.toolCallId
    if (!id) continue
    const pending = query.pendingToolCalls.get(id)
    if (pending) {
      query.pendingToolCalls.delete(id)
      pending.resolve(result)
    } else {
      query.pendingResults.set(id, result)
    }
  }
}

function trailingSteer(context: Context): InputContent[] {
  return context.messages.at(-1)?.role === 'user'
    ? currentPrompt(context.messages)
    : []
}

function emptyStream(
  stream: AssistantMessageEventStream,
  model: Model<any>,
): AssistantMessageEventStream {
  const turn = new ClaudeTurn(model, stream, new Map())
  queueMicrotask(() =>
    turn.handle({ type: 'result', subtype: 'success', result: '' }),
  )
  return stream
}

function failedStream(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  error: Error,
): AssistantMessageEventStream {
  const turn = new ClaudeTurn(model, stream, new Map())
  queueMicrotask(() => turn.fail(error))
  return stream
}

function transportEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    DISABLE_AUTO_COMPACT: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: '0',
  }
  for (const variable of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_SAFE_MODE',
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_VERTEX',
  ]) {
    delete environment[variable]
  }
  return environment
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error))
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: unknown }).message)
  return String(error)
}

export default function claude(pi: ExtensionAPI): void {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const provider: ProviderRuntime = {
    isolateNextStream: false,
    sessions: new Map<string, SessionRuntime>(),
  }

  const streamClaude = (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => streamClaudeCore(provider, model, context, options)

  pi.on('session_start', (event, ctx) => {
    bindSession(pi, ctx, provider)
    if (event.reason === 'fork')
      invalidateSession(provider, ctx.sessionManager.getSessionId(), true)
  })

  pi.on('session_tree', (_event, ctx) => {
    bindSession(pi, ctx, provider)
    invalidateSession(provider, ctx.sessionManager.getSessionId(), true)
  })

  pi.on('session_before_compact', (event, ctx) => {
    bindSession(pi, ctx, provider)
    provider.isolateNextStream = true
    event.signal.addEventListener(
      'abort',
      () => {
        provider.isolateNextStream = false
      },
      { once: true },
    )
  })

  pi.on('session_compact', (_event, ctx) => {
    provider.isolateNextStream = false
    bindSession(pi, ctx, provider)
    invalidateSession(provider, ctx.sessionManager.getSessionId(), true)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId()
    provider.sessions.get(id)?.active?.cleanup?.()
    provider.sessions.delete(id)
    if (provider.activeSessionId === id) provider.activeSessionId = undefined
  })

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: PROVIDER_ID,
    apiKey: 'not-used',
    api: PROVIDER_ID,
    models: applyLongContext(models),
    streamSimple: streamClaude as any,
  })
}
