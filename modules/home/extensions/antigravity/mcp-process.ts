// The MCP server AGY spawns. Speaks JSON-RPC over stdio to AGY, and the
// bridge protocol over a unix socket to Pi. Every tools/call blocks here until
// Pi has executed the tool, which is what keeps tool execution inside Pi.
//
// Launched by ~/.gemini/config/mcp_config.json with a fixed argv, so the
// per-session socket path arrives through the environment instead.

import { connectUnixSocket, mcpInputSchema, McpOutput } from '@pi/lib/provider/mcp-transport'
import { NdjsonLineBuffer } from '@pi/lib/provider/ndjson'
import { SOCKET_ENVIRONMENT_VARIABLE, type McpToPi, type PiToMcp, type ToolDefinition } from './bridge-protocol.js'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, any>
}

const socketPath = process.env[SOCKET_ENVIRONMENT_VARIABLE]
if (!socketPath) throw new Error(`${SOCKET_ENVIRONMENT_VARIABLE} is not set; Pi did not spawn this process`)

const socket = await connectUnixSocket(socketPath)
const output = new McpOutput()
const pending = new Map<string, { resolve: (result: PiToMcp) => void; reject: (error: Error) => void }>()
// JSON-RPC id -> bridge requestId, so notifications/cancelled can find and
// reject the in-flight call instead of leaking it until process cleanup.
const inflight = new Map<string | number, string>()
const CANCELLED = new Error('Request cancelled by AGY')
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
const socketLines = new NdjsonLineBuffer('Pi tool bridge')
socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  try {
    for (const line of socketLines.push(chunk)) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as PiToMcp
      if (message.type === 'tools') {
        announceTools(message.tools)
        continue
      }
      if (message.type !== 'result') continue
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
const stdinLines = new NdjsonLineBuffer('AGY MCP input')
for await (const chunk of Bun.stdin.stream()) {
  for (const line of stdinLines.push(decoder.decode(chunk, { stream: true }))) {
    if (line.trim()) void handle(JSON.parse(line) as JsonRpcRequest)
  }
}
stdinLines.push(decoder.decode())
const stdinTail = stdinLines.finish()
if (stdinTail?.trim()) void handle(JSON.parse(stdinTail) as JsonRpcRequest)

async function handle(request: JsonRpcRequest): Promise<void> {
  if (request.method === 'notifications/cancelled') {
    const bridgeId = inflight.get(request.params?.requestId)
    const call = bridgeId === undefined ? undefined : pending.get(bridgeId)
    if (bridgeId !== undefined) pending.delete(bridgeId)
    call?.reject(CANCELLED)
    return
  }
  // Other notifications carry no id. AGY closes the connection with "invalid
  // request" if one is answered, so they are dropped without exception.
  if (request.id === undefined || request.id === null) return

  try {
    switch (request.method) {
      // Undocumented probe AGY sends before initialize, carrying
      // protocolVersion 2026-07-28. An empty result is enough; leaving it
      // unanswered is reported upstream to wedge tool discovery.
      case 'server/discover':
        return await respond(request.id, {})
      case 'initialize':
        return await respond(request.id, {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pi', version: '1.0.0' }
        })
      case 'ping':
        return await respond(request.id, {})
      case 'tools/list':
        await catalogue
        return await respond(request.id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: mcpInputSchema(tool.inputSchema)
          }))
        })
      case 'tools/call':
        return await callTool(request)
      default:
        return await respondError(request.id, -32601, `Method not found: ${request.method}`)
    }
  } catch (error) {
    // A cancelled request must not be answered.
    if (error === CANCELLED) return
    await respondError(request.id, -32603, error instanceof Error ? error.message : String(error))
  }
}

async function callTool(request: JsonRpcRequest): Promise<void> {
  const name = request.params?.name
  const tool = typeof name === 'string' ? byName.get(name) : undefined
  if (!tool) throw new Error(`Unknown tool: ${String(name)}`)

  const requestId = crypto.randomUUID()
  const rpcId = request.id as string | number
  inflight.set(rpcId, requestId)
  let result: PiToMcp
  try {
    result = await new Promise<PiToMcp>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      send({
        type: 'call',
        requestId,
        name: tool.name,
        arguments: (request.params?.arguments as Record<string, unknown>) ?? {}
      })
    })
  } finally {
    inflight.delete(rpcId)
  }
  if (result.type !== 'result') throw new Error('Pi tool bridge returned an unexpected message')
  await respond(request.id, { content: result.content, isError: result.isError })
}

function send(message: McpToPi): void {
  socket.write(`${JSON.stringify(message)}\n`)
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function respond(id: JsonRpcRequest['id'], result: unknown): Promise<void> {
  return output.write({ jsonrpc: '2.0', id, result })
}

function respondError(id: JsonRpcRequest['id'], code: number, message: string): Promise<void> {
  return output.write({ jsonrpc: '2.0', id, error: { code, message } })
}
