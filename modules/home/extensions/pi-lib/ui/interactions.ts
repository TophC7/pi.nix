// ABOUT: Shared keyboard navigation primitives for list-style and settings-
// style overlays. pi-tui already exposes matchesKey + Key for raw key match,
// and SelectList/SettingsList for full list components. This module adds a
// tiny ListNav state machine that other extensions can adopt without
// instantiating a full pi-tui Component — for cases where you just need a
// cursor over a custom-rendered row list with consistent up/down/wrap.

import { matchesKey } from '@mariozechner/pi-tui'

export interface ListNavOptions {
  readonly count: number
  readonly wrap?: boolean
}

export interface ListNavState {
  readonly index: number
  handleInput(data: string): boolean
  moveTo(index: number): void
  resize(count: number): void
}

export function createListNav(options: ListNavOptions): ListNavState {
  let index = 0
  let count = options.count
  const wrap = options.wrap ?? true

  function clamp(next: number): number {
    if (count <= 0) return 0
    if (wrap) return ((next % count) + count) % count
    return Math.max(0, Math.min(count - 1, next))
  }

  function updateIndex(next: number): boolean {
    const clamped = clamp(next)
    if (clamped === index) return false
    index = clamped
    return true
  }

  const state: ListNavState = {
    get index() {
      return index
    },
    handleInput(data) {
      if (matchesKey(data, 'up')) return updateIndex(index - 1)
      if (matchesKey(data, 'down')) return updateIndex(index + 1)
      if (matchesKey(data, 'home')) return updateIndex(0)
      if (matchesKey(data, 'end')) return updateIndex(Math.max(0, count - 1))
      return false
    },
    moveTo(next) {
      index = clamp(next)
    },
    resize(nextCount) {
      count = nextCount
      if (index >= count) index = Math.max(0, count - 1)
    }
  }
  return state
}

export type { KeyId } from '@mariozechner/pi-tui'
// Re-export pi-tui interaction primitives so extensions can import everything
// from a single @pi/lib/ui path.
export { Key, matchesKey } from '@mariozechner/pi-tui'
