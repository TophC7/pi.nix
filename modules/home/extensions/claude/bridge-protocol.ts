import type { McpResult } from '@pi/lib/provider/tool-results'

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: unknown
}

export type McpToPiMessage =
  | { type: 'hello' }
  | { type: 'ready' }
  | {
      type: 'call'
      toolCallId: string
      requestId: string
    }

export type PiToMcpMessage =
  | { type: 'tools'; tools: ToolDefinition[] }
  | {
      type: 'result'
      requestId: string
      content: McpResult['content']
      isError?: McpResult['isError']
    }
