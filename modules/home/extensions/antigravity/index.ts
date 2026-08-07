import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { newAssistantMessageEventStream } from '@pi/lib/provider/messages'
import {
  alignSessionHistory,
  persistSessionState,
  type ContextDigest,
  type SessionStateRuntime
} from '@pi/lib/provider/session-state'
import { agyArguments, agyEnvironment } from './agy-command.js'
import { AgyProcess } from './agy-process.js'
import { assertHostConfiguration } from './gate.js'
import { createToolBridge } from './mcp-bridge.js'
import { agyModelSlug, buildModels } from './models.js'
import { AgyQuery } from './query-state.js'
import {
  bootstrapPrompt,
  contextDigest,
  currentPrompt,
  priorMessages,
  restoredSessionState,
  SESSION_ENTRY_TYPE,
  type PersistedSessionState
} from './session-state.js'
import { AgyTurn } from './stream-events.js'
import { prepareAgyWorkspace, removeAgyWorkspace } from './workspace.js'
import { extractAllToolResults, type McpResult } from '@pi/lib/provider/tool-results'

const PROVIDER_ID = 'antigravity'
const PRINT_TIMEOUT = '30m'

type SessionBinding = { append: (state: PersistedSessionState) => void; workspace?: string }
type SessionRuntime = SessionStateRuntime<PersistedSessionState, SessionBinding> & {
  active?: AgyQuery
}
type ProviderRuntime = {
  activeQueries: Set<AgyQuery>
  activeSessionId?: string
  fallbackWorkspace?: string
  fallbackWorkspaceId: string
  isolateNextStream: boolean
  sessions: Map<string, SessionRuntime>
}

function streamAntigravityCore(
  provider: ProviderRuntime,
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined
): AssistantMessageEventStream {
  const stream = newAssistantMessageEventStream()
  const piSessionId = provider.activeSessionId

  // Tool results in the context tail belong to an AGY process that is still
  // running and blocked on the matching MCP call. Attach a new turn to it
  // rather than starting anything.
  const results = toolResults(context)
  const owner = results.length > 0 ? queryForResults(provider, results) : undefined
  if (owner) {
    owner.latestMessages = context.messages
    owner.attach(new AgyTurn(model, stream))
    owner.deliver(results)
    return stream
  }
  if (context.messages.at(-1)?.role === 'toolResult') return emptyStream(stream, model)

  const session = piSessionId ? (provider.sessions.get(piSessionId) ?? {}) : {}
  const isolated = provider.isolateNextStream || !session.binding
  provider.isolateNextStream = false
  if (!isolated && piSessionId) {
    session.active?.cleanup?.()
    provider.sessions.set(piSessionId, session)
  }

  const history = priorMessages(context.messages)
  const alignment = alignSessionHistory(session, model.id, history, isolated, contextDigest)
  const conversation = alignment.state?.conversationId
  const prompt =
    alignment.aligned || history.length === 0 ? currentPrompt(context.messages) : bootstrapPrompt(context.messages)
  if (!prompt) return failedStream(stream, model, new Error('Antigravity prompt is empty'))

  let query: AgyQuery
  try {
    assertHostConfiguration()
    query = startQuery({
      model,
      context,
      options,
      prompt,
      conversation,
      workspace: queryWorkspace(provider, session, piSessionId),
      isolated
    })
  } catch (error) {
    return failedStream(stream, model, asError(error))
  }

  query.latestMessages = context.messages
  query.attach(new AgyTurn(model, stream))

  let aborted = false
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    query.releasePending('Pi ended the turn before this tool call completed.')
    query.bridge.close()
    query.process.close()
    provider.activeQueries.delete(query)
    if (!isolated && session.active === query) session.active = undefined
  }
  const abort = () => {
    if (aborted) return
    aborted = true
    query.process.interrupt()
    query.turn?.fail(new Error('Operation aborted'), true)
    cleanup()
  }
  query.cleanup = abort

  if (!isolated) {
    session.active = query
    provider.activeQueries.add(query)
  }
  if (options?.signal) {
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
  }

  void consume(query, () => aborted)
    .then((reachedTerminal) => {
      if (reachedTerminal && !alignment.isolated && !aborted && piSessionId) {
        persistCompletedSession(provider, piSessionId, model, query, alignment.historyDigest)
      }
    })
    .catch((error: unknown) => {
      if (!isolated && piSessionId && provider.sessions.get(piSessionId)?.active === query) {
        invalidateSession(provider, piSessionId, true)
      }
      query.turn?.fail(asError(error), aborted)
    })
    .finally(() => {
      if (options?.signal) options.signal.removeEventListener('abort', abort)
      cleanup()
    })

  return stream
}

function startQuery(options: {
  model: Model<any>
  context: Context
  options: SimpleStreamOptions | undefined
  prompt: string
  conversation?: string
  workspace: string
  isolated: boolean
}): AgyQuery {
  // The bridge is created first so its socket path can be handed to the
  // process, but its callbacks only fire once the process is running, by which
  // point `query` is assigned.
  let query: AgyQuery | undefined
  const modelSlug = agyModelSlug(options.model.id, options.options?.reasoning)
  const bridge = createToolBridge({
    // Delivered by AGY's PreInvocation hook as a transient system message.
    systemPrompt: options.context.systemPrompt,
    // An isolated stream (compaction, summarisation) must not be able to act.
    tools: options.isolated ? [] : (options.context.tools ?? []),
    onCall: async (name, args) => {
      query?.assertReady()
      const turn = query?.turn
      if (!query || !turn || turn.isFinished) {
        throw new Error('Pi has no active turn for this tool call')
      }
      const toolCallId = crypto.randomUUID()
      const result = query.awaitToolResult(toolCallId)
      turn.emitToolCall(toolCallId, name, args)
      return result
    },
    onError: (error) => {
      // A broken bridge strands AGY on its next MCP call: fail the visible
      // turn, then tear the whole query down (process, bridge, pending calls)
      // rather than leaving it to the 30-minute print timeout.
      query?.turn?.fail(error)
      query?.cleanup?.()
    }
  })

  try {
    const process = new AgyProcess({
      executable: 'agy',
      args: agyArguments({
        model: modelSlug,
        prompt: options.prompt,
        conversation: options.conversation,
        timeout: PRINT_TIMEOUT
      }),
      cwd: options.workspace,
      env: agyEnvironment(bridge.socketPath)
    })
    query = new AgyQuery(process, bridge, { cwd: options.workspace, model: modelSlug })
    return query
  } catch (error) {
    bridge.close()
    throw error
  }
}

/** Drives the AGY process for the whole Pi turn. Resolves true on a terminal result. */
async function consume(query: AgyQuery, wasAborted: () => boolean): Promise<boolean> {
  for await (const message of query.process) {
    if (wasAborted()) return false
    const conversationId = message.conversation_id ?? message.result?.conversation_id
    if (typeof conversationId === 'string' && conversationId) query.conversationId = conversationId
    if (query.route(message) === 'terminal') return true
  }
  if (wasAborted()) return false
  throw new Error('agy output ended before a terminal result')
}

function persistCompletedSession(
  provider: ProviderRuntime,
  piSessionId: string,
  model: Model<any>,
  query: AgyQuery,
  historyDigest: ContextDigest
): void {
  if (!query.conversationId || !query.turn) return
  const conversationId = query.conversationId
  const appended = [...query.latestMessages.slice(historyDigest.messageCount), query.turn.message]
  const session = provider.sessions.get(piSessionId) ?? {}
  persistSessionState(session, historyDigest, appended, (digest): PersistedSessionState => ({
    version: 1,
    conversationId,
    modelId: model.id,
    ...digest
  }))
  provider.sessions.set(piSessionId, session)
}

function invalidateSession(provider: ProviderRuntime, piSessionId: string, persistReset: boolean): void {
  const session = provider.sessions.get(piSessionId) ?? {}
  session.active?.cleanup?.()
  session.active = undefined
  session.persisted = { version: 1, reset: true }
  session.validated = undefined
  provider.sessions.set(piSessionId, session)
  if (persistReset) session.binding?.append(session.persisted)
}

function bindSession(pi: ExtensionAPI, ctx: ExtensionContext, provider: ProviderRuntime): void {
  const piSessionId = ctx.sessionManager.getSessionId()
  const session = provider.sessions.get(piSessionId) ?? {}
  provider.activeSessionId = piSessionId
  session.binding = {
    append: (state) => pi.appendEntry(SESSION_ENTRY_TYPE, state),
    workspace: session.binding?.workspace
  }
  session.persisted = restoredSessionState(ctx.sessionManager.getBranch())
  session.validated = undefined
  provider.sessions.set(piSessionId, session)
}

function queryWorkspace(
  provider: ProviderRuntime,
  session: SessionRuntime,
  piSessionId?: string
): string {
  if (session.binding && piSessionId) {
    return (session.binding.workspace ??= prepareAgyWorkspace(piSessionId))
  }
  return (provider.fallbackWorkspace ??= prepareAgyWorkspace(provider.fallbackWorkspaceId))
}

function toolResults(context: Context): McpResult[] {
  return extractAllToolResults(
    context.messages as unknown as Array<{
      role: string
      content?: unknown
      toolCallId?: string
      isError?: boolean
    }>
  )
}

function queryForResults(provider: ProviderRuntime, results: McpResult[]): AgyQuery | undefined {
  for (const result of results) {
    if (!result.toolCallId) continue
    for (const query of provider.activeQueries) {
      if (query.owns(result.toolCallId)) return query
    }
  }
  return undefined
}

function emptyStream(stream: AssistantMessageEventStream, model: Model<any>): AssistantMessageEventStream {
  const turn = new AgyTurn(model, stream)
  queueMicrotask(() => turn.handle({ event: 'result', result: { status: 'SUCCESS', response: '' } }))
  return stream
}

function failedStream(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  error: Error
): AssistantMessageEventStream {
  const turn = new AgyTurn(model, stream)
  queueMicrotask(() => turn.fail(error))
  return stream
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export default function antigravity(pi: ExtensionAPI): void {
  const provider: ProviderRuntime = {
    activeQueries: new Set<AgyQuery>(),
    fallbackWorkspaceId: `unbound-${crypto.randomUUID()}`,
    isolateNextStream: false,
    sessions: new Map<string, SessionRuntime>()
  }

  pi.on('session_start', (event, ctx) => {
    bindSession(pi, ctx, provider)
    if (event.reason === 'fork') invalidateSession(provider, ctx.sessionManager.getSessionId(), true)
  })

  pi.on('session_tree', (_event, ctx) => {
    bindSession(pi, ctx, provider)
    invalidateSession(provider, ctx.sessionManager.getSessionId(), true)
  })

  pi.on('session_before_compact', (event, ctx) => {
    bindSession(pi, ctx, provider)
    provider.isolateNextStream = true
    event.signal.addEventListener('abort', () => (provider.isolateNextStream = false), { once: true })
  })

  pi.on('session_compact', (_event, ctx) => {
    provider.isolateNextStream = false
    bindSession(pi, ctx, provider)
    invalidateSession(provider, ctx.sessionManager.getSessionId(), true)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId()
    const session = provider.sessions.get(id)
    session?.active?.cleanup?.()
    removeAgyWorkspace(session?.binding?.workspace)
    removeAgyWorkspace(provider.fallbackWorkspace)
    provider.fallbackWorkspace = undefined
    provider.sessions.delete(id)
    if (provider.activeSessionId === id) provider.activeSessionId = undefined
  })

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: PROVIDER_ID,
    apiKey: 'not-used',
    api: PROVIDER_ID,
    models: buildModels(),
    streamSimple: ((model: Model<any>, context: Context, options?: SimpleStreamOptions) =>
      streamAntigravityCore(provider, model, context, options)) as any
  })
}
