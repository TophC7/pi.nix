import type { McpResult } from './extract-tool-results.js'

export type McpToPiMessage =
  | { type: 'ready' }
  | {
      type: 'call'
      toolCallId: string
      requestId: string
    }

export type PiToMcpMessage = {
  type: 'result'
  requestId: string
  content: McpResult['content']
  isError?: McpResult['isError']
}
