import { calculateCost, type AssistantMessage, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai'
import { newAssistantMessage } from '@pi/lib/provider/messages'
import type { AgyMessage } from './agy-process.js'
import { assertCompletedToolAllowed } from './gate.js'

export type TurnOutcome = 'continue' | 'terminal'

/**
 * Translates one AGY NDJSON stream into Pi assistant events.
 *
 * A turn is bound to a single Pi stream, but the AGY process spans several of
 * them: each Pi tool call ends the current stream with `toolUse` so Pi can
 * execute the tool, and the next streamSimple call attaches a fresh turn to
 * the same still-running process.
 */
export class AgyTurn {
  readonly message: AssistantMessage
  readonly toolCallIds: string[] = []

  private started = false
  private finished = false
  private textBlock: { stepIndex: number; contentIndex: number } | null = null

  constructor(
    private readonly model: Model<any>,
    private readonly stream: AssistantMessageEventStream
  ) {
    this.message = newAssistantMessage(model)
  }

  get isFinished(): boolean {
    return this.finished
  }

  handle(message: AgyMessage): TurnOutcome {
    if (message.event === 'step_update') {
      this.handleStep(message.step_update ?? {})
      return 'continue'
    }
    if (message.event !== 'result') return 'continue'

    const result = message.result ?? {}
    if (String(result.status).toUpperCase() !== 'SUCCESS') {
      throw new Error(resultError(message))
    }
    // result.usage is deliberately ignored: it is the sum across every request
    // AGY made, which is not a context size. See updateUsage.
    this.closeText()
    if (this.message.content.length === 0 && typeof result.response === 'string' && result.response) {
      this.emitText(result.response)
    }
    this.finish('stop')
    return 'terminal'
  }

  /**
   * Emits a Pi tool call for a blocked MCP request and ends the stream so Pi
   * executes it. The id is minted by Pi: AGY's tools/call carries no
   * correlatable identifier of its own.
   */
  emitToolCall(id: string, name: string, args: Record<string, unknown>): void {
    this.closeText()
    this.start()
    const contentIndex = this.message.content.length
    this.toolCallIds.push(id)
    this.message.content.push({ type: 'toolCall', id, name, arguments: args } as any)
    this.stream.push({ type: 'toolcall_start', contentIndex, partial: this.message })
    this.stream.push({
      type: 'toolcall_end',
      contentIndex,
      toolCall: this.message.content[contentIndex] as any,
      partial: this.message
    })
    this.message.stopReason = 'toolUse'
    this.finish('toolUse')
  }

  fail(error: Error, aborted = false): void {
    if (this.finished) return
    this.message.stopReason = aborted ? 'aborted' : 'error'
    this.message.errorMessage = error.message
    this.stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: this.message })
    this.finished = true
    this.stream.end()
  }

  private handleStep(step: Record<string, any>): void {
    const state = String(step.state ?? '').toUpperCase()
    if (step.usage) this.updateUsage(step.usage)

    switch (step.step_type) {
      case 'agent_response':
        if (typeof step.text_delta === 'string' && step.text_delta) {
          this.appendText(Number(step.step_index ?? 0), step.text_delta)
        }
        if (state === 'DONE') this.closeText()
        return
      case 'tool':
        assertCompletedToolAllowed(step, state)
        return
      default:
        // error_message, checkpoint, system_message, user_input, finish,
        // unknown: no Pi-visible effect.
        //
        // error_message is what a gate denial looks like, and it arrives with
        // an entirely empty payload — no name, no text, no error field. It is
        // not fatal: the model narrates the refusal in the next
        // agent_response and the turn still ends SUCCESS. Real failures are
        // reported by the terminal result's status instead.
        return
    }
  }

  private appendText(stepIndex: number, delta: string): void {
    this.start()
    if (this.textBlock && this.textBlock.stepIndex !== stepIndex) this.closeText()
    if (!this.textBlock) {
      const contentIndex = this.message.content.length
      this.message.content.push({ type: 'text', text: '' })
      this.textBlock = { stepIndex, contentIndex }
      this.stream.push({ type: 'text_start', contentIndex, partial: this.message })
    }
    const block = this.message.content[this.textBlock.contentIndex] as { type: 'text'; text: string }
    block.text += delta
    this.stream.push({ type: 'text_delta', contentIndex: this.textBlock.contentIndex, delta, partial: this.message })
  }

  private closeText(): void {
    if (!this.textBlock) return
    const { contentIndex } = this.textBlock
    this.textBlock = null
    const block = this.message.content[contentIndex] as { type: 'text'; text: string }
    this.stream.push({ type: 'text_end', contentIndex, content: block.text, partial: this.message })
  }

  private emitText(text: string): void {
    this.appendText(-1, text)
    this.closeText()
  }

  /**
   * AGY reports usage per step, and each step is a separate request: a turn
   * mixes one large conversation request with small auxiliary ones (a
   * checkpoint step billed 99 tokens next to a 9,064-token response step).
   *
   * Output accumulates, because every step genuinely produced those tokens.
   * Input and cache reads take the maximum instead, since Pi reads them as
   * "how full is the context window" — summing would inflate it, and taking
   * the latest would let an auxiliary request erase it.
   */
  private updateUsage(usage: Record<string, number | undefined>): void {
    const total = this.message.usage
    total.input = Math.max(total.input, usage.input_tokens ?? 0)
    total.cacheRead = Math.max(total.cacheRead, usage.cache_read_tokens ?? 0)
    total.output += (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0)
    total.totalTokens = total.input + total.output + total.cacheRead
    calculateCost(this.model, total)
  }

  private start(): void {
    if (this.started) return
    this.started = true
    this.stream.push({ type: 'start', partial: this.message })
  }

  private finish(reason: 'stop' | 'toolUse'): void {
    if (this.finished) return
    this.start()
    this.stream.push({ type: 'done', reason, message: this.message })
    this.finished = true
    this.stream.end()
  }
}

function resultError(message: AgyMessage): string {
  const result = message.result ?? {}
  if (typeof result.error === 'string' && result.error) return result.error
  if (typeof message.error === 'string' && message.error) return message.error
  return `agy failed (${String(result.status ?? 'unknown status')})`
}
