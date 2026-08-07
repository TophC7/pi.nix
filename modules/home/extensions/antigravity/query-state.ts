import type { Context } from '@earendil-works/pi-ai'
import type { AgyMessage, AgyProcess } from './agy-process.js'
import type { ToolBridge } from './mcp-bridge.js'
import type { AgyTurn } from './stream-events.js'
import type { McpResult } from '@pi/lib/provider/tool-results'

const MAX_BUFFERED_MESSAGES = 256
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

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

  constructor(
    readonly process: AgyProcess,
    readonly bridge: ToolBridge
  ) {}

  attach(turn: AgyTurn): void {
    this.turn = turn
    const buffered = this.buffered
    this.buffered = []
    this.bufferedBytes = 0
    for (const message of buffered) turn.handle(message)
  }

  /** Routes an AGY message to the live turn, or holds it until one attaches. */
  route(message: AgyMessage): 'continue' | 'terminal' {
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
