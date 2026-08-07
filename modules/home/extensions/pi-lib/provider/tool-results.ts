// Pi appends tool results to context and calls the provider again. Collect the
// current turn's results, walking past injected steer/follow-up user messages
// and stopping at the nearest assistant turn boundary.

export type McpContent = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

export interface McpResult {
  content: McpContent
  isError?: boolean
  toolCallId?: string
  [key: string]: unknown
}

type ToolResultMessage = {
  role: string
  content?: unknown
  toolCallId?: string
  isError?: boolean
  [key: string]: unknown
}

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string }

export function toolResultToMcpContent(content: string | ContentBlock[]): McpContent {
  if (typeof content === 'string') return [{ type: 'text', text: content || '' }]
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const blocks: McpContent = []
  for (const block of content) {
    if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'image' && block.data && block.mimeType) {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }]
}

export function extractAllToolResults(messages: ToolResultMessage[]): McpResult[] {
  const results: McpResult[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'toolResult') {
      results.push({
        content: toolResultToMcpContent(message.content as string | ContentBlock[]),
        isError: message.isError,
        toolCallId: message.toolCallId
      })
    } else if (message.role === 'assistant') {
      break
    }
  }
  return results.reverse()
}
