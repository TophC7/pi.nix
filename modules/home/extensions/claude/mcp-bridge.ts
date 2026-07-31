import type { Tool } from '@earendil-works/pi-ai'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpToPiMessage, PiToMcpMessage } from './bridge-protocol.js'
import type { McpResult } from './extract-tool-results.js'
import { MCP_SERVER_NAME } from './mcp-names.js'
import type { QueryContext } from './query-state.js'

export interface ToolBridge {
  mcpConfig: string
  ready: Promise<void>
  close: () => void
}

export function createToolBridge(
  tools: Tool[],
  queryContext: QueryContext,
  bunExecutable: string,
): ToolBridge | undefined {
  if (tools.length === 0) return undefined

  const directory = mkdtempSync(join(tmpdir(), 'pi-claude-tools-'))
  const socketPath = join(directory, 'bridge.sock')
  const manifestPath = join(directory, 'tools.json')
  const processPath = fileURLToPath(
    new URL('./mcp-process.ts', import.meta.url),
  )
  const manifest = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }))
  writeFileSync(manifestPath, JSON.stringify(manifest))

  const sockets = new Set<Socket>()
  let closed = false
  let failed = false
  let readinessSettled = false
  let markReady: () => void = () => undefined
  let rejectReady: (error: Error) => void = () => undefined
  let readinessTimeout: ReturnType<typeof setTimeout>
  const ready = new Promise<void>((resolve, reject) => {
    markReady = () => {
      if (readinessSettled) return
      readinessSettled = true
      clearTimeout(readinessTimeout)
      resolve()
    }
    rejectReady = (error) => {
      if (readinessSettled) return
      readinessSettled = true
      clearTimeout(readinessTimeout)
      reject(error)
    }
  })
  readinessTimeout = setTimeout(
    () =>
      rejectReady(
        new Error(
          'Claude MCP tool bridge did not become ready within 10 seconds',
        ),
      ),
    10_000,
  )

  const fail = (error: Error) => {
    if (failed || closed) return
    failed = true
    rejectReady(error)
    for (const pending of queryContext.pendingToolCalls.values()) {
      pending.resolve({
        content: [
          {
            type: 'text',
            text: `Claude MCP bridge failed: ${error.message}`,
          },
        ],
        isError: true,
      })
    }
    queryContext.pendingToolCalls.clear()
    queryContext.pendingResults.clear()
    queryContext.cleanup?.()
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message: McpToPiMessage
        try {
          message = JSON.parse(line) as McpToPiMessage
        } catch {
          fail(
            new Error(
              `Claude MCP bridge emitted invalid JSON: ${line.slice(0, 500)}`,
            ),
          )
          return
        }
        if (message.type === 'ready') markReady()
        else handleCall(message, socket, queryContext)
      }
    })
    socket.on('error', (error) => fail(error))
    socket.on('close', () => {
      sockets.delete(socket)
      fail(new Error('Claude MCP bridge socket closed'))
    })
  })
  server.on('error', (error) => fail(error))
  server.listen(socketPath)

  const mcpConfig = JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: bunExecutable,
        args: [processPath, manifestPath, socketPath],
      },
    },
  })

  return {
    mcpConfig,
    ready,
    close() {
      if (closed) return
      closed = true
      rejectReady(
        new Error('Claude MCP tool bridge closed before becoming ready'),
      )
      for (const socket of sockets) socket.destroy()
      server.close(() => rmSync(directory, { recursive: true, force: true }))
    },
  }
}

function handleCall(
  call: Extract<McpToPiMessage, { type: 'call' }>,
  socket: Socket,
  queryContext: QueryContext,
): void {
  const deliver = (result: McpResult) => {
    const message: PiToMcpMessage = {
      type: 'result',
      requestId: call.requestId,
      content: result.content,
      isError: result.isError,
    }
    socket.write(`${JSON.stringify(message)}\n`)
  }

  const queued = queryContext.pendingResults.get(call.toolCallId)
  if (queued) {
    queryContext.pendingResults.delete(call.toolCallId)
    deliver(queued)
    return
  }

  queryContext.pendingToolCalls.set(call.toolCallId, { resolve: deliver })
}
