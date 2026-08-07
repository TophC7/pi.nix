import type { McpContent } from '@pi/lib/provider/tool-results'

// Line-delimited JSON over a unix socket, between Pi (server) and the MCP
// process AGY spawns (client).
//
// The tool catalogue travels over the socket rather than a manifest file
// because AGY reads a *static* mcp_config.json: argv is fixed at Nix build
// time, so nothing per-session can be passed that way. The socket path itself
// arrives through the environment, which AGY propagates to the MCP child.

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: unknown
}

export type McpToPi =
  | { type: 'hello' }
  | { type: 'call'; requestId: string; name: string; arguments: Record<string, unknown> }

export type PiToMcp =
  | { type: 'tools'; tools: ToolDefinition[] }
  | { type: 'result'; requestId: string; content: McpContent; isError?: boolean }

export const SOCKET_ENVIRONMENT_VARIABLE = 'PI_AGY_BRIDGE_SOCKET'
