import type { Context } from '@earendil-works/pi-ai'
import type { McpResult } from './extract-tool-results.js'
import type { PromptStream } from './prompt-stream.js'
import type { ClaudeTurn } from './stream-events.js'

export interface PendingToolCall {
  resolve: (result: McpResult) => void
}

export class QueryContext {
  promptStream: PromptStream | null = null
  turn: ClaudeTurn | null = null
  toolNames = new Map<string, string>()
  cleanup: (() => void) | null = null
  claudeSessionId?: string
  latestMessages: Context['messages'] = []
  pendingToolCalls = new Map<string, PendingToolCall>()
  pendingResults = new Map<string, McpResult>()
}
