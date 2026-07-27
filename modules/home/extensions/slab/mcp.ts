import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// INFO: pi-mcp-adapter publishes status snapshots on pi's shared extension event
// bus, documented in its README under "Runtime status snapshots". The channel
// name carries the payload version, so an adapter that bumps it sends us nothing
// and the footer falls back to the plain `mcp` status text.
const MCP_STATUS_EVENT = 'pi-mcp-adapter/status/v1'

export type SlabMcpServerStatus = 'connected' | 'needs-auth' | 'failed' | 'cached' | 'not-connected'

export interface SlabMcpServerSnapshot {
  readonly name: string
  readonly status: SlabMcpServerStatus
}

export interface SlabMcpStatusSnapshot {
  readonly total: number
  readonly ok: number
  readonly totalTools: number
  readonly servers: readonly SlabMcpServerSnapshot[]
}

let cachedSnapshot: SlabMcpStatusSnapshot | undefined

export function readMcpStatusSnapshot(): SlabMcpStatusSnapshot | undefined {
  return cachedSnapshot
}

/** Mirror adapter status snapshots into the footer, redrawing on every update. */
export function subscribeMcpStatus(pi: ExtensionAPI, onChange: () => void): () => void {
  const unsubscribe = pi.events.on(MCP_STATUS_EVENT, (payload) => {
    cachedSnapshot = parseSnapshot(payload)
    onChange()
  })

  return () => {
    unsubscribe()
    cachedSnapshot = undefined
  }
}

function parseSnapshot(value: unknown): SlabMcpStatusSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { readonly servers?: unknown; readonly totalTools?: unknown }
  if (!Array.isArray(record.servers)) return undefined

  const servers = record.servers.map(parseServer).filter((server): server is SlabMcpServerSnapshot => Boolean(server))
  const ok = servers.filter((server) => server.status === 'connected' || server.status === 'cached').length
  return {
    total: servers.length,
    ok,
    totalTools: numberValue(record.totalTools),
    servers
  }
}

function parseServer(value: unknown): SlabMcpServerSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { readonly name?: unknown; readonly status?: unknown; readonly disabled?: unknown }
  const name = stringValue(record.name)
  // Disabled servers are configured off on purpose, so they stay out of the counts.
  if (!name || record.disabled === true || record.status === 'disabled') return undefined
  return { name, status: statusValue(record.status) ?? 'not-connected' }
}

function statusValue(value: unknown): SlabMcpServerStatus | undefined {
  return value === 'connected' || value === 'needs-auth' || value === 'failed' || value === 'cached' || value === 'not-connected'
    ? value
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
