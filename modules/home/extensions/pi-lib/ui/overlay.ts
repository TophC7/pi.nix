import type { ExtensionCommandContext, Theme } from '@mariozechner/pi-coding-agent'
import type { Component, TUI } from '@mariozechner/pi-tui'
import { centeredOverlayOptions } from './layout.ts'

// ABOUT: Generic overlay lifecycle helper around ctx.ui.custom. Wraps the
// boilerplate so extensions don't repeat the close/dispose/notify dance.
// Overlays use the pi-tui `Component` surface; `UiComponentLike` is for
// inline widget hosts. Keep them separate — mixing reintroduces editor/
// overlay coupling.

export interface OverlayFactoryArgs {
  readonly tui: TUI
  readonly theme: Theme
  /** Closes the overlay and resolves `ctx.ui.custom`. Safe to call repeatedly. */
  readonly close: () => void
}

export interface OverlayOptions {
  readonly width?: number | `${number}%`
  readonly maxHeight?: number | `${number}%`
}

export interface OverlayHandle {
  /** Close the overlay if still open. Idempotent. */
  hide(): void
  isHidden(): boolean
}

export function openOverlay(
  ctx: ExtensionCommandContext,
  factory: (args: OverlayFactoryArgs) => Component,
  options: OverlayOptions = {}
): OverlayHandle {
  let close: (() => void) | undefined
  let closed = false

  const finish = () => {
    if (closed) return
    closed = true
    close?.()
  }

  void ctx.ui
    .custom<void>((tui, theme, _keybindings, done) => {
      close = () => done(undefined)
      if (closed) queueMicrotask(close)
      return factory({ tui, theme, close: finish })
    }, centeredOverlayOptions(options))
    .catch((error) => {
      ctx.ui.notify(`Overlay failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })

  return {
    hide: finish,
    isHidden: () => closed
  }
}
