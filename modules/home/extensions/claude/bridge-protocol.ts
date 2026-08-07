import type { McpResult } from '@pi/lib/provider/tool-results'

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
