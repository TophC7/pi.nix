import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import type { McpToPiMessage, PiToMcpMessage } from './bridge-protocol.js'

const TOOL_USE_ID_META = 'claudecode/toolUseId'
const EMPTY_SCHEMA = { type: 'object', properties: {} }

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
if (!manifestPath || !socketPath)
  throw new Error('usage: mcp-process.ts <manifest> <socket>')

const tools = JSON.parse(readFileSync(manifestPath, 'utf8')) as ToolDefinition[]
const byName = new Map(tools.map((tool) => [tool.name, tool]))
const socket = await connect(socketPath)
const pending = new Map<
  string,
  {
    resolve: (result: PiToMcpMessage) => void
    reject: (error: Error) => void
  }
>()
let socketBuffer = ''
let announcedReady = false
let outputChain = Promise.resolve()

socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  socketBuffer += chunk
  const lines = socketBuffer.split('\n')
  socketBuffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const result = JSON.parse(line) as PiToMcpMessage
    const request = pending.get(result.requestId)
    if (!request) continue
    pending.delete(result.requestId)
    request.resolve(result)
  }
})
socket.on('error', (error) => rejectPending(error))
socket.on('close', () => {
  rejectPending(new Error('Pi tool bridge socket closed'))
  queueMicrotask(() => process.exit(1))
})

const decoder = new TextDecoder()
let stdinBuffer = ''
for await (const chunk of Bun.stdin.stream()) {
  stdinBuffer += decoder.decode(chunk, { stream: true })
  const lines = stdinBuffer.split('\n')
  stdinBuffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    void handle(JSON.parse(line) as JsonRpcRequest)
  }
}

async function handle(request: JsonRpcRequest): Promise<void> {
  try {
    switch (request.method) {
      case 'initialize':
        await respond(request.id, {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pi-claude-tools', version: '1.0.0' },
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
            inputSchema: inputSchema(tool.inputSchema),
          })),
        })
        return
      case 'tools/call':
        await callTool(request)
        return
      default:
        if (request.id !== undefined) {
          await respondError(
            request.id,
            -32601,
            `Method not found: ${request.method}`,
          )
        }
    }
  } catch (error) {
    if (request.id !== undefined) {
      await respondError(
        request.id,
        -32603,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

async function callTool(request: JsonRpcRequest): Promise<void> {
  const name = request.params?.name
  const tool = typeof name === 'string' ? byName.get(name) : undefined
  if (!tool) throw new Error(`Unknown tool: ${String(name)}`)
  const toolCallId = request.params?._meta?.[TOOL_USE_ID_META]
  if (typeof toolCallId !== 'string') {
    throw new Error(
      `${tool.name}: tools/call missing _meta["${TOOL_USE_ID_META}"]`,
    )
  }

  const requestId = crypto.randomUUID()
  const result = await new Promise<PiToMcpMessage>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    const message: McpToPiMessage = {
      type: 'call',
      requestId,
      toolCallId,
    }
    socket.write(`${JSON.stringify(message)}\n`)
  })
  await respond(request.id, {
    content: result.content,
    isError: result.isError,
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
  return write({ jsonrpc: '2.0', id, result })
}

function respondError(
  id: string | number,
  code: number,
  message: string,
): Promise<void> {
  return write({ jsonrpc: '2.0', id, error: { code, message } })
}

function write(message: unknown): Promise<void> {
  outputChain = outputChain.then(async () => {
    await Bun.write(Bun.stdout, `${JSON.stringify(message)}\n`)
  })
  return outputChain
}

function inputSchema(schema: unknown): Record<string, unknown> {
  const value = schema as Record<string, unknown> | undefined
  return value?.type === 'object' && value.properties ? value : EMPTY_SCHEMA
}

async function connect(path: string): Promise<Socket> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const candidate = createConnection(path)
        candidate.once('connect', () => resolve(candidate))
        candidate.once('error', reject)
      })
    } catch {
      await Bun.sleep(20)
    }
  }
  throw new Error(`Unable to connect to Pi tool bridge at ${path}`)
}
