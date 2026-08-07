import type { Tool } from '@earendil-works/pi-ai'
import { NdjsonLineBuffer } from '@pi/lib/provider/ndjson'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpToPi, PiToMcp, ToolDefinition } from './bridge-protocol.js'
import type { McpResult } from '@pi/lib/provider/tool-results'

export interface ToolBridge {
  readonly socketPath: string
  readonly helloReceived: boolean
  readonly promptServed: boolean
  close: () => void
}

// Pi side of the bridge: owns the unix socket, serves the system prompt and
// tool catalogue, and hands each tools/call to `onCall`. The returned promise
// holds AGY's MCP request open while Pi executes the tool.
export function createToolBridge(options: {
  systemPrompt: string
  tools: Tool[]
  onCall: (name: string, args: Record<string, unknown>) => Promise<McpResult>
  onError: (error: Error) => void
}): ToolBridge {
  const { systemPrompt, tools, onCall, onError } = options
  const directory = mkdtempSync(join(tmpdir(), 'pi-agy-bridge-'))
  const socketPath = join(directory, 'bridge.sock')
  const catalogue: ToolDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters
  }))

  const sockets = new Set<Socket>()
  let closed = false
  let helloReceived = false
  let promptServed = false

  const fail = (error: Error) => {
    if (closed) return
    onError(error)
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    const lines = new NdjsonLineBuffer('Pi tool bridge')
    const write = (message: PiToMcp) => socket.write(`${JSON.stringify(message)}\n`)

    socket.on('data', (chunk) => {
      try {
        for (const line of lines.push(chunk)) {
          if (!line.trim()) continue
          let message: McpToPi
          try {
            message = JSON.parse(line) as McpToPi
          } catch {
            throw new Error(`Pi tool bridge received invalid JSON: ${line.slice(0, 500)}`)
          }
          if (message.type === 'hello') {
            helloReceived = true
            write({ type: 'tools', tools: catalogue })
            continue
          }
          if (message.type === 'prompt') {
            promptServed = true
            write({ type: 'prompt', systemPrompt })
            continue
          }
          void onCall(message.name, message.arguments)
            .then((result) =>
              write({
                type: 'result',
                requestId: message.requestId,
                content: result.content,
                isError: result.isError
              })
            )
            .catch((error: unknown) =>
              write({
                type: 'result',
                requestId: message.requestId,
                content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
                isError: true
              })
            )
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      }
    })
    socket.on('error', (error) => fail(error))
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('error', (error) => fail(error))
  server.listen(socketPath)

  return {
    socketPath,
    get helloReceived() {
      return helloReceived
    },
    get promptServed() {
      return promptServed
    },
    close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      server.close(() => rmSync(directory, { recursive: true, force: true }))
    }
  }
}
