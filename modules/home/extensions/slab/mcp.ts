import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type SlabMcpServerStatus = 'connected' | 'needs-auth' | 'failed' | 'cached' | 'not-connected'

export interface SlabMcpServerSnapshot {
  readonly name: string
  readonly status: SlabMcpServerStatus
  readonly toolCount: number
  readonly failedAgeSeconds?: number
}

export interface SlabMcpActivitySnapshot {
  readonly kind: 'connecting'
  readonly serverName?: string
}

export interface SlabMcpStatusSnapshot {
  readonly version: 1
  readonly updatedAt: number
  readonly total: number
  readonly connected: number
  readonly ok: number
  readonly cached: number
  readonly needsAuth: number
  readonly failed: number
  readonly totalTools: number
  readonly servers: readonly SlabMcpServerSnapshot[]
  readonly activity?: SlabMcpActivitySnapshot
}

const STATUS_MAX_AGE_MS = 120_000
const STATUS_POLL_INTERVAL_MS = 1_000
let cachedPath: string | undefined
let cachedMtime = 0
let cachedSnapshot: SlabMcpStatusSnapshot | undefined

export function readMcpStatusSnapshot(now = Date.now()): SlabMcpStatusSnapshot | undefined {
  if (!cachedSnapshot || now - cachedSnapshot.updatedAt > STATUS_MAX_AGE_MS) return undefined
  return cachedSnapshot
}

async function refreshMcpStatusSnapshot(): Promise<boolean> {
  const previousMtime = cachedMtime
  const previousSnapshot = cachedSnapshot
  const path = mcpStatusPath()
  try {
    const file = await stat(path)
    if (file.mtimeMs !== cachedMtime) {
      cachedMtime = file.mtimeMs
      cachedSnapshot = parseSnapshot(JSON.parse(await readFile(path, 'utf-8')))
    }
  } catch {
    cachedMtime = 0
    cachedSnapshot = undefined
  }
  return cachedMtime !== previousMtime || cachedSnapshot !== previousSnapshot
}

export function startMcpStatusPolling(onChange: () => void): () => void {
  let disposed = false
  let inFlight = false
  let visibleSnapshot = readMcpStatusSnapshot()

  const poll = async (): Promise<void> => {
    if (disposed || inFlight) return
    inFlight = true
    try {
      const changed = await refreshMcpStatusSnapshot()
      if (disposed) return
      const nextVisibleSnapshot = readMcpStatusSnapshot()
      if (changed || nextVisibleSnapshot !== visibleSnapshot) {
        visibleSnapshot = nextVisibleSnapshot
        onChange()
      }
    } finally {
      inFlight = false
    }
  }

  void poll()
  const timer = setInterval(() => void poll(), STATUS_POLL_INTERVAL_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    disposed = true
    clearInterval(timer)
  }
}

function mcpStatusPath(): string {
  if (cachedPath) return cachedPath
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  const agentDir = configured ? resolveHome(configured) : join(homedir(), '.pi', 'agent')
  cachedPath = join(agentDir, 'mcp-status.json')
  return cachedPath
}

function resolveHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function parseSnapshot(value: unknown): SlabMcpStatusSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<SlabMcpStatusSnapshot>
  if (record.version !== 1 || !Number.isFinite(record.updatedAt) || !Array.isArray(record.servers)) return undefined
  return {
    version: 1,
    updatedAt: numberValue(record.updatedAt),
    total: numberValue(record.total),
    connected: numberValue(record.connected),
    ok: numberValue(record.ok),
    cached: numberValue(record.cached),
    needsAuth: numberValue(record.needsAuth),
    failed: numberValue(record.failed),
    totalTools: numberValue(record.totalTools),
    servers: record.servers.map(parseServer).filter((server): server is SlabMcpServerSnapshot => Boolean(server)),
    ...(record.activity?.kind === 'connecting' ? { activity: { kind: 'connecting', serverName: stringValue(record.activity.serverName) } } : {})
  }
}

function parseServer(value: unknown): SlabMcpServerSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<SlabMcpServerSnapshot>
  const name = stringValue(record.name)
  const status = statusValue(record.status)
  if (!name || !status) return undefined
  const failedAgeSeconds = Number.isFinite(record.failedAgeSeconds) ? numberValue(record.failedAgeSeconds) : undefined
  return {
    name,
    status,
    toolCount: numberValue(record.toolCount),
    ...(failedAgeSeconds !== undefined ? { failedAgeSeconds } : {})
  }
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
