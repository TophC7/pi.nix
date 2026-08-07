import {
  connectUnixSocket,
  dispatchJsonRpcLine,
  mcpInputSchema,
  McpOutput
} from '@pi/lib/provider/mcp-transport'
import { NdjsonLineBuffer } from '@pi/lib/provider/ndjson'
import type { McpToPiMessage, PiToMcpMessage, ToolDefinition } from './bridge-protocol.js'

const TOOL_USE_ID_META = 'claudecode/toolUseId'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, any>
}

const [socketPath] = process.argv.slice(2)
if (!socketPath) throw new Error('usage: mcp-process.ts <socket>')

const socket = await connectUnixSocket(socketPath)
const output = new McpOutput()
type BridgeResult = Extract<PiToMcpMessage, { type: 'result' }>
const pending = new Map<
  string,
  {
    resolve: (result: BridgeResult) => void
    reject: (error: Error) => void
  }
>()
const inflight = new Map<string | number, string>()
const CANCELLED = new Error('Request cancelled by Claude')
let tools: ToolDefinition[] = []
let byName = new Map<string, ToolDefinition>()
let announceTools: (definitions: ToolDefinition[]) => void = () => undefined
const catalogue = new Promise<void>((resolve) => {
  announceTools = (definitions) => {
    tools = definitions
    byName = new Map(definitions.map((tool) => [tool.name, tool]))
    resolve()
  }
})
let announcedReady = false
const socketLines = new NdjsonLineBuffer('Pi tool bridge')

socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  try {
    for (const line of socketLines.push(String(chunk))) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as PiToMcpMessage
      if (message.type === 'tools') {
        announceTools(message.tools)
        continue
      }
      const request = pending.get(message.requestId)
      if (!request) continue
      pending.delete(message.requestId)
      request.resolve(message)
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

send({ type: 'hello' })

const decoder = new TextDecoder()
const stdinLines = new NdjsonLineBuffer('Claude MCP input')
for await (const chunk of Bun.stdin.stream()) {
  for (const line of stdinLines.push(decoder.decode(chunk, { stream: true }))) {
    dispatchJsonRpcLine(line, output, handle)
  }
}
stdinLines.push(decoder.decode())
const stdinTail = stdinLines.finish()
if (stdinTail !== undefined) dispatchJsonRpcLine(stdinTail, output, handle)

async function handle(request: JsonRpcRequest): Promise<void> {
  if (request.method === 'notifications/cancelled') {
    const rpcId = request.params?.requestId
    const bridgeId = typeof rpcId === 'string' || typeof rpcId === 'number' ? inflight.get(rpcId) : undefined
    const call = bridgeId === undefined ? undefined : pending.get(bridgeId)
    if (bridgeId !== undefined) pending.delete(bridgeId)
    call?.reject(CANCELLED)
    return
  }

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
        return
      case 'ping':
        await respond(request.id, {})
        return
      case 'tools/list':
        await catalogue
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
    if (error === CANCELLED) return
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
  const rpcId = request.id
  if (typeof rpcId === 'string' || typeof rpcId === 'number') inflight.set(rpcId, requestId)
  let result: BridgeResult
  try {
    result = await new Promise<BridgeResult>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      send({
        type: 'call',
        requestId,
        toolCallId
      })
    })
  } finally {
    if (typeof rpcId === 'string' || typeof rpcId === 'number') inflight.delete(rpcId)
  }
  await respond(request.id, {
    content: result.content,
    isError: result.isError
  })
}

function send(message: McpToPiMessage): void {
  socket.write(`${JSON.stringify(message)}\n`)
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function announceReady(): void {
  if (announcedReady) return
  announcedReady = true
  send({ type: 'ready' })
}

function respond(id: JsonRpcRequest['id'], result: unknown): Promise<void> {
  if (id === undefined) return Promise.resolve()
  return output.write({ jsonrpc: '2.0', id, result })
}

function respondError(id: JsonRpcRequest['id'], code: number, message: string): Promise<void> {
  return output.write({ jsonrpc: '2.0', id, error: { code, message } })
}
