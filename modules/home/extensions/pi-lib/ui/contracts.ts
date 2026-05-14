/**
 * Component surface used by widget host runtimes.
 *
 * `invalidate()` is required: the host calls it after focus/input changes and
 * during scheduler animation ticks so the next render is recomputed. A no-op
 * implementation is fine for stateless components, but the method must exist.
 * `handleInput` and `dispose` remain optional.
 */
export interface UiComponentLike {
  render(width: number): string[]
  handleInput?(data: string): void
  invalidate(): void
  dispose?(): void
}

export type UiOwner = string
export type UiEntryId = string

export type UiTone = 'accent' | 'muted' | 'dim' | 'success' | 'warning' | 'error' | 'text'

export type UiPriority = 'critical' | 'high' | 'normal' | 'low' | 'background'

export type UiWidgetPlacement = 'aboveEditor' | 'belowEditor' | 'footer'

export interface UiRenderCapabilities {
  readonly color: boolean
  readonly unicode: boolean
}

export interface UiRenderClock {
  readonly now: number
  readonly tick: number
}

export interface UiRenderContext extends UiRenderClock {
  readonly width: number
  readonly capabilities: UiRenderCapabilities
}

export type UiRenderableText = string | ((context: UiRenderContext) => string)
export type UiRenderableLines = readonly string[] | ((context: UiRenderContext) => readonly string[])

/**
 * Shared UI entry lifecycle metadata.
 *
 * `ttlMs` is accepted only by publish helpers and is normalized at publish time
 * into an absolute `expiresAt` timestamp. Refreshing an entry updates
 * `updatedAt` for stale checks, but does not extend `expiresAt`; TTL is an
 * absolute lifetime for that publication. `staleAfterMs` is relative to
 * `updatedAt`, so `UiPublicationHandle.refresh()` extends stale freshness.
 */
export interface UiLifecycle {
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt?: number
  readonly staleAfterMs?: number
}

export interface UiOrdering {
  readonly priority: UiPriority
  readonly order: number
}

export interface UiSchedule {
  readonly throttleMs?: number
  readonly animateEveryMs?: number
}

export interface UiStatusEntry {
  readonly id: UiEntryId
  readonly owner: UiOwner
  readonly label?: string
  readonly text: UiRenderableText
  readonly tone?: UiTone
  readonly ordering: UiOrdering
  readonly lifecycle: UiLifecycle
  readonly schedule?: UiSchedule
}

export interface UiWidgetEntry {
  readonly id: UiEntryId
  readonly owner: UiOwner
  readonly placement: UiWidgetPlacement
  readonly content: UiRenderableLines | ((context: UiRenderContext) => UiComponentLike)
  readonly ordering: UiOrdering
  readonly lifecycle: UiLifecycle
  readonly schedule?: UiSchedule
}

export interface UiSnapshot {
  readonly statuses: readonly UiStatusEntry[]
  readonly widgets: readonly UiWidgetEntry[]
  readonly version: number
}

export interface UiPublicationHandle {
  readonly id: UiEntryId
  clear(): void
  /** Refreshes `updatedAt` for stale checks without extending absolute TTL. */
  refresh(now?: number): void
}

export interface UiStoreSubscription {
  unsubscribe(): void
}

export interface UiStatusPublisher {
  publishStatus(entry: UiStatusEntry): UiPublicationHandle
  publishWidget(entry: UiWidgetEntry): UiPublicationHandle
  clearOwner(owner: UiOwner): void
}

export interface UiStatusStore extends UiStatusPublisher {
  /**
   * Returns current in-memory snapshot. Entries published before slab loads are
   * visible here and are emitted immediately to new subscribers, so slab reloads
   * reuse current state instead of losing producer publications.
   */
  snapshot(): UiSnapshot
  /** New subscribers receive current snapshot immediately. */
  subscribe(listener: (snapshot: UiSnapshot) => void): UiStoreSubscription
  /** Removes entries whose absolute `expiresAt` or relative `staleAfterMs` elapsed. */
  sweepStale(now?: number): void
}

export interface UiTeardown {
  dispose(): void
}
