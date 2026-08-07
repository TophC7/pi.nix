import { calculateCost, type AssistantMessage, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai'
import { newAssistantMessage } from '@pi/lib/provider/messages'
import type { ClaudeMessage } from './claude-process.js'
import { MCP_TOOL_PREFIX } from './mcp-names.js'

export class ClaudeTurn {
  readonly message: AssistantMessage
  readonly toolCallIds: string[] = []
  sessionId?: string

  private started = false
  private sawStreamEvent = false
  private sawToolCall = false
  private finished = false
  private readonly blockIndices = new Map<number, number>()

  constructor(
    private readonly model: Model<any>,
    private readonly stream: AssistantMessageEventStream,
    private readonly toolNames: Map<string, string>
  ) {
    this.message = newAssistantMessage(model)
  }

  handle(message: ClaudeMessage): boolean {
    if (message.type === 'system' && message.subtype === 'init') {
      this.sessionId = message.session_id ?? this.sessionId
      return false
    }

    if (message.type === 'stream_event') {
      this.sawStreamEvent = true
      this.handleStreamEvent(message.event)
      return false
    }

    if (message.type !== 'result') return false
    if (message.subtype !== 'success') throw new Error(resultError(message))

    // Result usage aggregates every API call in the query. Stream events already
    // hold this message's request usage, which Pi uses for compaction thresholds.
    if (!this.sawStreamEvent && message.usage) updateUsage(this.message, message.usage, this.model)
    if (!this.sawStreamEvent && message.result) this.emitFallbackText(message.result)
    this.finish(this.message.stopReason === 'length' ? 'length' : 'stop')
    return true
  }

  fail(error: Error, aborted = false): void {
    if (this.finished) return
    this.message.stopReason = aborted ? 'aborted' : 'error'
    this.message.errorMessage = error.message
    this.stream.push({
      type: 'error',
      reason: aborted ? 'aborted' : 'error',
      error: this.message
    })
    this.finished = true
    this.stream.end()
  }

  private handleStreamEvent(event: any): void {
    if (event?.type === 'message_start') {
      if (event.message?.usage) updateUsage(this.message, event.message.usage, this.model)
      return
    }

    if (event?.type === 'content_block_start') {
      this.start()
      const block = event.content_block
      const contentIndex = this.message.content.length
      if (block?.type === 'text') {
        this.blockIndices.set(event.index, contentIndex)
        this.message.content.push({ type: 'text', text: '' })
        this.stream.push({
          type: 'text_start',
          contentIndex,
          partial: this.message
        })
      } else if (block?.type === 'thinking') {
        this.blockIndices.set(event.index, contentIndex)
        this.message.content.push({
          type: 'thinking',
          thinking: '',
          thinkingSignature: ''
        })
        this.stream.push({
          type: 'thinking_start',
          contentIndex,
          partial: this.message
        })
      } else if (block?.type === 'tool_use') {
        this.blockIndices.set(event.index, contentIndex)
        this.sawToolCall = true
        this.toolCallIds.push(block.id)
        this.message.content.push({
          type: 'toolCall',
          id: block.id,
          name: this.piToolName(block.name),
          arguments: block.input ?? {},
          partialJson: ''
        } as any)
        this.stream.push({
          type: 'toolcall_start',
          contentIndex,
          partial: this.message
        })
      }
      return
    }

    if (event?.type === 'content_block_delta') {
      const contentIndex = this.blockIndices.get(event.index)
      if (contentIndex === undefined) return
      const block = this.message.content[contentIndex] as any
      if (!block) return
      if (event.delta?.type === 'text_delta' && block.type === 'text') {
        block.text += event.delta.text
        this.stream.push({
          type: 'text_delta',
          contentIndex,
          delta: event.delta.text,
          partial: this.message
        })
      } else if (event.delta?.type === 'thinking_delta' && block.type === 'thinking') {
        block.thinking += event.delta.thinking
        this.stream.push({
          type: 'thinking_delta',
          contentIndex,
          delta: event.delta.thinking,
          partial: this.message
        })
      } else if (event.delta?.type === 'signature_delta' && block.type === 'thinking') {
        block.thinkingSignature += event.delta.signature
      } else if (event.delta?.type === 'input_json_delta' && block.type === 'toolCall') {
        block.partialJson += event.delta.partial_json
        this.stream.push({
          type: 'toolcall_delta',
          contentIndex,
          delta: event.delta.partial_json,
          partial: this.message
        })
      }
      return
    }

    if (event?.type === 'content_block_stop') {
      const contentIndex = this.blockIndices.get(event.index)
      if (contentIndex === undefined) return
      this.blockIndices.delete(event.index)
      const block = this.message.content[contentIndex] as any
      if (!block) return
      if (block.type === 'text') {
        this.stream.push({
          type: 'text_end',
          contentIndex,
          content: block.text,
          partial: this.message
        })
      } else if (block.type === 'thinking') {
        this.stream.push({
          type: 'thinking_end',
          contentIndex,
          content: block.thinking,
          partial: this.message
        })
      } else if (block.type === 'toolCall') {
        block.arguments = parseJson(block.partialJson, block.arguments)
        block.arguments = mapToolArguments(block.name, block.arguments)
        delete block.partialJson
        this.stream.push({
          type: 'toolcall_end',
          contentIndex,
          toolCall: block,
          partial: this.message
        })
      }
      return
    }

    if (event?.type === 'message_delta') {
      this.message.stopReason = mapStopReason(event.delta?.stop_reason)
      if (event.usage) updateUsage(this.message, event.usage, this.model)
      return
    }

    if (event?.type === 'message_stop' && this.sawToolCall) {
      this.message.stopReason = 'toolUse'
      this.finish('toolUse')
    }
  }

  private emitFallbackText(text: string): void {
    this.start()
    const contentIndex = this.message.content.length
    this.message.content.push({ type: 'text', text })
    this.stream.push({
      type: 'text_start',
      contentIndex,
      partial: this.message
    })
    this.stream.push({
      type: 'text_delta',
      contentIndex,
      delta: text,
      partial: this.message
    })
    this.stream.push({
      type: 'text_end',
      contentIndex,
      content: text,
      partial: this.message
    })
  }

  private start(): void {
    if (this.started) return
    this.started = true
    this.stream.push({ type: 'start', partial: this.message })
  }

  private finish(reason: 'stop' | 'length' | 'toolUse'): void {
    if (this.finished) return
    this.start()
    this.stream.push({ type: 'done', reason, message: this.message })
    this.finished = true
    this.stream.end()
  }

  private piToolName(name: string): string {
    const mapped = this.toolNames.get(name) ?? this.toolNames.get(name.toLowerCase())
    if (mapped) return mapped
    return name.toLowerCase().startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
  }
}

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
  output.usage.input = usage.input_tokens ?? output.usage.input
  output.usage.output = usage.output_tokens ?? output.usage.output
  output.usage.cacheRead = usage.cache_read_input_tokens ?? output.usage.cacheRead
  output.usage.cacheWrite = usage.cache_creation_input_tokens ?? output.usage.cacheWrite
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite
  calculateCost(model, output.usage)
}

function mapStopReason(reason?: string): 'stop' | 'length' | 'toolUse' {
  if (reason === 'tool_use') return 'toolUse'
  if (reason === 'max_tokens') return 'length'
  return 'stop'
}

function mapToolArguments(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const renames: Record<string, string> =
    {
      read: { file_path: 'path' },
      write: { file_path: 'path' },
      edit: {
        file_path: 'path',
        old_string: 'oldText',
        new_string: 'newText',
        old_text: 'oldText',
        new_text: 'newText'
      }
    }[toolName.toLowerCase()] ?? {}
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const mapped = renames[key] ?? key
    if (!(mapped in result)) result[mapped] = value
  }
  if (toolName.toLowerCase() === 'bash' && result.timeout == null) result.timeout = 120
  return result
}

function parseJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback
  try {
    return JSON.parse(input)
  } catch {
    return fallback
  }
}

function resultError(message: ClaudeMessage): string {
  if (typeof message.error === 'string') return message.error
  if (typeof message.result === 'string' && message.result) return message.result
  return `Claude Code failed (${message.subtype ?? 'unknown result'})`
}
