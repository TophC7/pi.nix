import { padLine, renderFooterColumns, stripControls, type UiRenderCapabilities } from '@pi/lib/ui'
import type { SlabMcpServerSnapshot, SlabMcpStatusSnapshot } from './mcp.ts'
import { paintIf } from './palette.ts'

const MCP_STATUS_KEYS = ['mcp', 'mcp-auth'] as const
const FOOTER_PADDING_X = 1

export interface SlabFooterRightRail {
  readonly footerLine?: string
  readonly leftWidth?: number
  readonly railWidth?: number
  readonly gapWidth?: number
}

export function renderSlabFooterLines(
  extensionStatuses: ReadonlyMap<string, string>,
  rightWidgetLines: readonly string[],
  width: number,
  capabilities: UiRenderCapabilities,
  rightRail: SlabFooterRightRail = {},
  mcpState?: SlabMcpStatusSnapshot
): string[] {
  const leftWidth = rightRail.leftWidth && rightRail.leftWidth < width ? rightRail.leftWidth : width
  const innerLeftWidth = footerInnerWidth(leftWidth)
  const mcpLine = renderMcpFooterLine(extensionStatuses, capabilities, innerLeftWidth, mcpState)
  const leftLines = mcpLine ? [mcpLine] : []
  const lines = renderFooterColumns(leftLines, rightWidgetLines, innerLeftWidth, capabilities)
    .map((line) => padFooterSurface(line, leftWidth))
  if (!rightRail.footerLine || !rightRail.railWidth) {
    return leftWidth < width ? lines.map((line) => padLine(line, width)) : lines
  }

  const rows = Math.max(1, lines.length)
  const gap = ' '.repeat(rightRail.gapWidth ?? 0)
  const result: string[] = []
  for (let index = 0; index < rows; index++) {
    const left = lines[index] ?? padFooterSurface('', leftWidth)
    result.push(index === 0 ? `${left}${gap}${padLine(rightRail.footerLine, rightRail.railWidth)}` : left)
  }
  return result
}

function footerInnerWidth(width: number): number {
  return Math.max(0, width - FOOTER_PADDING_X * 2)
}

function padFooterSurface(line: string, width: number): string {
  if (width <= FOOTER_PADDING_X * 2) return padLine(line, width)
  const padding = ' '.repeat(FOOTER_PADDING_X)
  return `${padding}${padLine(line, footerInnerWidth(width))}${padding}`
}

export function renderMcpFooterLine(
  extensionStatuses: ReadonlyMap<string, string>,
  capabilities: UiRenderCapabilities,
  width: number,
  mcpState?: SlabMcpStatusSnapshot
): string | undefined {
  const authServer = parseAuthServer(extensionStatuses.get('mcp-auth'))
  if (mcpState) return renderStructuredMcpLine(mcpState, authServer, capabilities, width)

  const statuses = MCP_STATUS_KEYS
    .map((key) => normalizeMcpStatus(key, extensionStatuses.get(key)))
    .filter((status): status is string => Boolean(status))

  if (statuses.length === 0) return undefined

  return joinMcpParts(statuses, capabilities)
}

function renderStructuredMcpLine(
  state: SlabMcpStatusSnapshot,
  activeAuthServer: string | undefined,
  capabilities: UiRenderCapabilities,
  width: number
): string | undefined {
  if (state.total === 0) return undefined

  const mode = width < 24 ? 'tight' : width < 44 ? 'medium' : 'wide'
  const icon = mcpIcons(capabilities)
  const label = paintIf(capabilities.color, 'cyan', 'mcp')
  const okCount = Math.max(0, state.ok)

  if (state.activity?.kind === 'connecting') {
    const server = state.activity.serverName
    if (mode === 'tight') return `${label} ${icon.busy}${server ? ` ${server}` : ''}`
    return `${label} ${icon.busy} connecting${server ? ` ${server}` : ''}`
  }

  const issues = issuePhrases(state.servers, activeAuthServer)
  if (issues.length > 0) {
    if (mode === 'tight') return `${label} ${icon.warn}${issues.length}`
    if (mode === 'medium') {
      const [first, ...rest] = issues
      const extra = rest.length > 0 ? `${separator(capabilities)}+${rest.length}` : ''
      const ok = okCount > 0 ? `${separator(capabilities)}${okCount} ok` : ''
      return `${label} ${icon.warn} ${first}${extra}${ok}`
    }
    const ok = okCount > 0 ? [`${okCount} ok`] : []
    return `${label} ${icon.warn} ${[...issues.slice(0, 2), ...ok].join(separator(capabilities))}`
  }

  if (mode === 'tight') return `${label} ${icon.ok}${okCount}/${state.total}`
  if (mode === 'medium') return `${label} ${icon.ok} ${okCount}/${state.total}${state.totalTools > 0 ? ` · ${state.totalTools}t` : ''}`
  return `${label} ${icon.ok} ${serverCountText(state.total)}${state.totalTools > 0 ? `${separator(capabilities)}${state.totalTools} tools` : ''}`
}

function issuePhrases(servers: readonly SlabMcpServerSnapshot[], activeAuthServer: string | undefined): string[] {
  const issues: string[] = []
  if (activeAuthServer) issues.push(`${activeAuthServer} auth`)
  for (const server of servers) {
    if (server.name === activeAuthServer) continue
    if (server.status === 'needs-auth') issues.push(`${server.name} auth`)
    if (server.status === 'failed') issues.push(`${server.name} failed`)
  }
  return issues
}

function serverCountText(count: number): string {
  return count === 1 ? '1 server' : `${count} servers`
}

function mcpIcons(capabilities: UiRenderCapabilities): { ok: string; warn: string; busy: string } {
  return capabilities.unicode ? { ok: '✓', warn: '⚠', busy: '…' } : { ok: 'ok ', warn: '!', busy: '...' }
}

function joinMcpParts(parts: readonly string[], capabilities: UiRenderCapabilities): string {
  const labelSeparator = paintIf(capabilities.color, 'dim', capabilities.unicode ? ' │ ' : ' | ')
  return `${paintIf(capabilities.color, 'cyan', 'mcp')}${labelSeparator}${parts.join(separator(capabilities))}`
}

function separator(capabilities: UiRenderCapabilities): string {
  return paintIf(capabilities.color, 'dim', capabilities.unicode ? ' · ' : ' | ')
}

function parseAuthServer(raw: string | undefined): string | undefined {
  const text = stripControls(raw ?? '').replace(/\s+/g, ' ').replace(/\.{3}$/, '').trim()
  return text.match(/^Authenticating\s+(.+)$/i)?.[1]?.trim()
}

type McpStatusKey = (typeof MCP_STATUS_KEYS)[number]

function normalizeMcpStatus(key: McpStatusKey, raw: string | undefined): string | undefined {
  const text = stripControls(raw ?? '').replace(/\s+/g, ' ').replace(/\.{3}$/, '').trim()
  if (!text) return undefined

  if (key === 'mcp-auth') return text.replace(/^Authenticating\s+/i, 'auth ')

  return text
    .replace(/^MCP:\s*/i, '')
    .replace(/^connecting to\s+/i, 'connecting ')
    .trim()
}
