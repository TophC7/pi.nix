import { visibleWidth } from '@mariozechner/pi-tui'
import { truncLine } from './ansi.ts'
import type { UiComponentLike } from './contracts.ts'

export function fitLine(text: string, width: number, ellipsis = '…'): string {
  const safeWidth = Math.max(0, width)
  if (visibleWidth(text) <= safeWidth) return text
  const ellipsisWidth = ellipsis ? visibleWidth(ellipsis) : 0
  const truncWidth = safeWidth - ellipsisWidth + 1 // +1 compensates truncLine's internal maxWidth-1
  const truncated = truncLine(text, Math.max(1, truncWidth))
  return truncated + ellipsis
}

export function padLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width)
  const extra = safeWidth - visibleWidth(text)
  return extra > 0 ? `${text}${' '.repeat(extra)}` : fitLine(text, safeWidth, '')
}

export function fitLines(lines: readonly string[], width: number, ellipsis = '…'): string[] {
  return lines.map((line) => fitLine(line, width, ellipsis))
}

export function componentFromLines(getLines: () => readonly string[]): UiComponentLike {
  return {
    render(width) {
      return fitLines(getLines(), width)
    },
    invalidate() {}
  }
}

export function emptyComponent(): UiComponentLike {
  return componentFromLines(() => [])
}
