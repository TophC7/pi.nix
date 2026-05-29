import type { Theme } from '@mariozechner/pi-coding-agent'
import { fitLine, padLine } from './render.ts'

export interface TabItem {
  readonly id: string
  readonly label: string
}

export interface RenderTabsOptions {
  readonly tabs: readonly TabItem[]
  readonly activeId: string | undefined
  readonly width: number
  readonly theme: Theme
}

export function renderTabs(options: RenderTabsOptions): string {
  const width = Math.max(1, options.width)
  if (options.tabs.length === 0) return padLine(options.theme.fg('muted', ' No sections registered.'), width)

  const separator = options.theme.fg('dim', ' │ ')
  const parts = options.tabs.flatMap((tab, index) => {
    const active = tab.id === options.activeId
    const label = active ? options.theme.bold(tab.label) : options.theme.fg('accent', tab.label)
    return index === 0 ? [label] : [separator, label]
  })
  return padLine(fitLine(parts.join(''), width), width)
}
