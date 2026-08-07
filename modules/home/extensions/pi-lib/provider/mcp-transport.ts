import { createConnection, type Socket } from 'node:net'

const EMPTY_SCHEMA = { type: 'object', properties: {} }

/** Serialized, flushed JSON-RPC output; buffering can deadlock MCP handshakes. */
export class McpOutput {
  private chain = Promise.resolve()

  write(message: unknown): Promise<void> {
    const write = this.chain.then(async () => {
      await Bun.write(Bun.stdout, `${JSON.stringify(message)}\n`)
    })
    this.chain = write.catch(() => undefined)
    return write
  }
}

/** Parses one framed request, reporting malformed JSON without killing the MCP process. */
export function dispatchJsonRpcLine<Request>(
  line: string,
  output: McpOutput,
  handle: (request: Request) => Promise<void>
): void {
  if (!line.trim()) return
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    void output
      .write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      .catch(() => undefined)
    return
  }
  void handle(request)
}

/**
 * Tools with no parameters get the empty object schema; valid object schemas
 * pass through untouched. Anything else is a malformed tool definition and
 * throws rather than being silently replaced with an unconstrained schema.
 */
export function mcpInputSchema(schema: unknown): Record<string, unknown> {
  if (schema === undefined || schema === null) return EMPTY_SCHEMA
  const value = schema as Record<string, unknown>
  if (typeof schema === 'object' && !Array.isArray(schema) && value.type === 'object') return value
  throw new Error(`Tool input schema is not an object JSON Schema: ${JSON.stringify(schema).slice(0, 200)}`)
}

export async function connectUnixSocket(path: string): Promise<Socket> {
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
