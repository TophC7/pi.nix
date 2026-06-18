import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { stripControls } from './ansi.ts'
import type { UiRenderCapabilities } from './contracts.ts'

// ABOUT: Pure rendering for the legacy footer-status compatibility row. Moved
// from slab/footer-bridge.ts in §T015 with no behavior change. Now uses the
// shared `stripControls` from ./ansi.ts. `renderFooterColumns` remains the
// generic left/right footer layout helper used by Slab's custom footer.

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

function clean(text: string, capabilities: UiRenderCapabilities): string {
  return capabilities.color ? text : text.replace(ANSI_PATTERN, '')
}

function fit(text: string, width: number, capabilities: UiRenderCapabilities): string {
  return truncateToWidth(clean(text, capabilities), Math.max(0, width), capabilities.unicode ? '…' : '...')
}

export function renderLegacyStatusRow(
  statuses: Iterable<string | undefined>,
  width: number,
  capabilities: UiRenderCapabilities
): string | undefined {
  const values = [...statuses]
    .map((status) => stripControls(status ?? ''))
    .map((status) => status.trim())
    .filter(Boolean)
  if (values.length === 0) return undefined
  const separator = capabilities.unicode ? ' · ' : ' | '
  const label = capabilities.unicode ? 'compat │ ' : 'compat | '
  return fit(`${label}${values.join(separator)}`, width, capabilities)
}

export interface FooterBridgeOptions {
  readonly rightWidgetLines?: readonly string[]
}

export function renderFooterBridgeLines(
  widgetLines: readonly string[],
  legacyStatuses: Iterable<string | undefined>,
  width: number,
  capabilities: UiRenderCapabilities,
  options: FooterBridgeOptions = {}
): string[] {
  const leftLines = widgetLines.map((line) => fit(line, width, capabilities))
  const legacy = renderLegacyStatusRow(legacyStatuses, width, capabilities)
  if (legacy) leftLines.push(legacy)

  return renderFooterColumns(leftLines, options.rightWidgetLines ?? [], width, capabilities)
}

export function renderFooterColumns(
  leftLines: readonly string[],
  rightLines: readonly string[],
  width: number,
  capabilities: UiRenderCapabilities
): string[] {
  const fittedLeft = leftLines.map((line) => fit(line, width, capabilities))
  const fittedRight = rightLines.map((line) => fit(line, width, capabilities))
  if (fittedRight.length === 0) return fittedLeft

  const rows = Math.max(fittedLeft.length, fittedRight.length)
  const lines: string[] = []
  for (let index = 0; index < rows; index++) {
    const left = fittedLeft[index] ?? ''
    const right = fittedRight[index] ?? ''
    if (visibleWidth(left) === 0 && visibleWidth(right) === 0) continue
    lines.push(joinFooterLine(left, right, width, capabilities))
  }
  return lines
}

function joinFooterLine(
  left: string,
  right: string,
  width: number,
  capabilities: UiRenderCapabilities
): string {
  const safeWidth = Math.max(0, width)
  const cleanRight = fit(right, safeWidth, capabilities)
  const rightWidth = visibleWidth(cleanRight)
  if (rightWidth === 0) return fit(left, safeWidth, capabilities)

  const leftBudget = Math.max(0, safeWidth - rightWidth - 1)
  const cleanLeft = fit(left, leftBudget, capabilities)
  const gap = ' '.repeat(Math.max(1, safeWidth - visibleWidth(cleanLeft) - rightWidth))
  return `${cleanLeft}${gap}${cleanRight}`
}
