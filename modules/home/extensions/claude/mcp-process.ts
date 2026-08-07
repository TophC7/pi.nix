import { connectUnixSocket, mcpInputSchema, McpOutput } from '@pi/lib/provider/mcp-transport'
import { NdjsonLineBuffer } from '@pi/lib/provider/ndjson'
import { readFileSync } from 'node:fs'
import type { McpToPiMessage, PiToMcpMessage } from './bridge-protocol.js'

const TOOL_USE_ID_META = 'claudecode/toolUseId'

type ToolDefinition = {
  name: string
  description: string
  inputSchema: unknown
}

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, any>
}

const [manifestPath, socketPath] = process.argv.slice(2)
if (!manifestPath || !socketPath) throw new Error('usage: mcp-process.ts <manifest> <socket>')

const tools = JSON.parse(readFileSync(manifestPath, 'utf8')) as ToolDefinition[]
const byName = new Map(tools.map((tool) => [tool.name, tool]))
const socket = await connectUnixSocket(socketPath)
const output = new McpOutput()
const pending = new Map<
  string,
  {
    resolve: (result: PiToMcpMessage) => void
    reject: (error: Error) => void
  }
>()
let announcedReady = false
const socketLines = new NdjsonLineBuffer('Pi tool bridge')

socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  try {
    for (const line of socketLines.push(chunk)) {
      if (!line.trim()) continue
      const result = JSON.parse(line) as PiToMcpMessage
      const request = pending.get(result.requestId)
      if (!request) continue
      pending.delete(result.requestId)
      request.resolve(result)
    }
  } catch (error) {
    socket.destroy(error instanceof Error ? error : new Error(String(error)))
  }
})
socket.on('error', (error) => rejectPending(error))
socket.on('close', () => {
  rejectPending(new Error('Pi tool bridge socket closed'))
  queueMicrotask(() => process.exit(1))
})

const decoder = new TextDecoder()
const stdinLines = new NdjsonLineBuffer('Claude MCP input')
for await (const chunk of Bun.stdin.stream()) {
  for (const line of stdinLines.push(decoder.decode(chunk, { stream: true }))) {
    if (line.trim()) void handle(JSON.parse(line) as JsonRpcRequest)
  }
}
stdinLines.push(decoder.decode())
const stdinTail = stdinLines.finish()
if (stdinTail?.trim()) void handle(JSON.parse(stdinTail) as JsonRpcRequest)

async function handle(request: JsonRpcRequest): Promise<void> {
  try {
    switch (request.method) {
      case 'initialize':
        await respond(request.id, {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pi-claude-tools', version: '1.0.0' }
        })
        return
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return
      case 'ping':
        await respond(request.id, {})
        return
      case 'tools/list':
        announceReady()
        await respond(request.id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: mcpInputSchema(tool.inputSchema)
          }))
        })
        return
      case 'tools/call':
        await callTool(request)
        return
      default:
        if (request.id !== undefined) {
          await respondError(request.id, -32601, `Method not found: ${request.method}`)
        }
    }
  } catch (error) {
    if (request.id !== undefined) {
      await respondError(request.id, -32603, error instanceof Error ? error.message : String(error))
    }
  }
}

async function callTool(request: JsonRpcRequest): Promise<void> {
  const name = request.params?.name
  const tool = typeof name === 'string' ? byName.get(name) : undefined
  if (!tool) throw new Error(`Unknown tool: ${String(name)}`)
  const toolCallId = request.params?._meta?.[TOOL_USE_ID_META]
  if (typeof toolCallId !== 'string') {
    throw new Error(`${tool.name}: tools/call missing _meta["${TOOL_USE_ID_META}"]`)
  }

  const requestId = crypto.randomUUID()
  const result = await new Promise<PiToMcpMessage>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    const message: McpToPiMessage = {
      type: 'call',
      requestId,
      toolCallId
    }
    socket.write(`${JSON.stringify(message)}\n`)
  })
  await respond(request.id, {
    content: result.content,
    isError: result.isError
  })
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function announceReady(): void {
  if (announcedReady) return
  announcedReady = true
  const message: McpToPiMessage = { type: 'ready' }
  socket.write(`${JSON.stringify(message)}\n`)
}

function respond(id: JsonRpcRequest['id'], result: unknown): Promise<void> {
  if (id === undefined) return Promise.resolve()
  return output.write({ jsonrpc: '2.0', id, result })
}

function respondError(id: string | number, code: number, message: string): Promise<void> {
  return output.write({ jsonrpc: '2.0', id, error: { code, message } })
}
