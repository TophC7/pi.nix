import type { Context } from '@earendil-works/pi-ai'
import type { AgyMessage, AgyProcess } from './agy-process.js'
import type { ToolBridge } from './mcp-bridge.js'
import type { AgyTurn } from './stream-events.js'
import type { McpResult } from '@pi/lib/provider/tool-results'

const MAX_BUFFERED_MESSAGES = 256
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export type AgyRuntimeExpectation = {
  cwd: string
  model: string
}

/**
 * One AGY process and everything hanging off it, for the length of a Pi turn.
 *
 * AGY owns the agent loop, so a single process spans several streamSimple
 * calls: `turn` is swapped for each new Pi stream while the process keeps
 * running. Messages that arrive with no live turn are buffered rather than
 * dropped — AGY is normally blocked on the MCP response at that point, but
 * losing output would be silent.
 */
export class AgyQuery {
  turn: AgyTurn | null = null
  conversationId?: string
  latestMessages: Context['messages'] = []
  cleanup: (() => void) | null = null

  private readonly pending = new Map<string, (result: McpResult) => void>()
  private buffered: AgyMessage[] = []
  private bufferedBytes = 0
  private initValidated = false

  constructor(
    readonly process: AgyProcess,
    readonly bridge: ToolBridge,
    private readonly expected: AgyRuntimeExpectation
  ) {}

  assertReady(): void {
    if (!this.initValidated) throw new Error('AGY produced model activity before a valid init event')
    if (!this.bridge.helloReceived) throw new Error('AGY did not connect to Pi\'s MCP bridge before inference')
    if (!this.bridge.promptServed) throw new Error('AGY did not request Pi\'s system prompt before inference')
  }

  attach(turn: AgyTurn): void {
    this.turn = turn
    const buffered = this.buffered
    this.buffered = []
    this.bufferedBytes = 0
    for (const message of buffered) turn.handle(message)
  }

  private validateInit(init: Record<string, unknown>): void {
    const permissionMode = init.permission_mode ?? init.permissionMode
    const tools = Array.isArray(init.tools) ? init.tools : []
    if (init.cwd !== this.expected.cwd) {
      throw new Error(`AGY started in unexpected workspace: ${String(init.cwd)}`)
    }
    if (init.model !== this.expected.model) {
      throw new Error(`AGY selected unexpected model: ${String(init.model)}`)
    }
    if (init.agent != null && init.agent !== '') {
      throw new Error(`AGY selected unexpected custom agent: ${String(init.agent)}`)
    }
    if (permissionMode !== 'request-review') {
      throw new Error(`AGY selected unsafe permission mode: ${String(permissionMode)}`)
    }
    if (!tools.includes('call_mcp_tool')) {
      throw new Error('AGY did not expose call_mcp_tool')
    }
    this.initValidated = true
  }

  /** Validates and routes an AGY message, or holds it until one attaches. */
  route(message: AgyMessage): 'continue' | 'terminal' {
    if (message.event === 'init') this.validateInit(message.init ?? {})
    if (isInferenceActivity(message)) this.assertReady()
    if (!this.turn || this.turn.isFinished) {
      this.bufferedBytes += JSON.stringify(message).length
      if (this.buffered.length >= MAX_BUFFERED_MESSAGES || this.bufferedBytes > MAX_BUFFERED_BYTES) {
        const error = new Error('agy emitted too much output while Pi had no attached turn')
        this.process.close(error)
        throw error
      }
      this.buffered.push(message)
      return 'continue'
    }
    return this.turn.handle(message)
  }

  owns(toolCallId: string): boolean {
    return this.pending.has(toolCallId) || (this.turn?.toolCallIds.includes(toolCallId) ?? false)
  }

  awaitToolResult(toolCallId: string): Promise<McpResult> {
    return new Promise<McpResult>((resolve) => this.pending.set(toolCallId, resolve))
  }

  deliver(results: McpResult[]): void {
    for (const result of results) {
      if (!result.toolCallId) continue
      const resolve = this.pending.get(result.toolCallId)
      if (!resolve) continue
      this.pending.delete(result.toolCallId)
      resolve(result)
    }
  }

  /** Unblocks every MCP call still waiting, so the AGY process can wind down. */
  releasePending(reason: string): void {
    for (const resolve of this.pending.values()) {
      resolve({ content: [{ type: 'text', text: reason }], isError: true })
    }
    this.pending.clear()
  }
}

function isInferenceActivity(message: AgyMessage): boolean {
  if (message.event === 'result') return true
  if (message.event !== 'step_update') return false
  return message.step_update?.step_type === 'agent_response' || message.step_update?.step_type === 'tool'
}
