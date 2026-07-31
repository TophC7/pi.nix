import type {
  UiEntryId,
  UiLifecycle,
  UiOrdering,
  UiPriority,
  UiPublicationHandle,
  UiRenderableLines,
  UiRenderableText,
  UiSchedule,
  UiSnapshot,
  UiStatusEntry,
  UiStatusStore,
  UiStoreSubscription,
  UiTone,
  UiWidgetEntry,
  UiWidgetPlacement
} from './contracts.ts'
import { createStore, type StoreSubscription } from './store.ts'

export interface PublishStatusInput {
  readonly id?: UiEntryId
  readonly owner: string
  readonly label?: string
  readonly icon?: string
  readonly text: UiRenderableText
  readonly tone?: UiTone
  readonly priority?: UiPriority
  readonly order?: number
  readonly ttlMs?: number
  readonly staleAfterMs?: number
  readonly schedule?: UiSchedule
}

export interface PublishWidgetInput {
  readonly id?: UiEntryId
  readonly owner: string
  /**
   * Required. Callers must pick a placement explicitly. Silent defaults
   * hid intent and produced widgets in unexpected slots; removed in §T004.
   */
  readonly placement: UiWidgetPlacement
  readonly content: UiRenderableLines | UiWidgetEntry['content']
  readonly priority?: UiPriority
  readonly order?: number
  readonly ttlMs?: number
  readonly staleAfterMs?: number
  readonly schedule?: UiSchedule
}

export interface UiStatusStoreWriter extends UiStatusStore {
  publishStatusInput(input: PublishStatusInput, now?: number): UiPublicationHandle
  publishWidgetInput(input: PublishWidgetInput, now?: number): UiPublicationHandle
}

const PRIORITY_ORDER: Record<UiPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4
}

const GLOBAL_STATE_KEY = '__piLibUiStatusStore'

interface SharedUiStatusStoreGlobalState {
  readonly store: UiStatusStoreWriter
  nextGeneratedId: number
}

function sharedGlobalState(): SharedUiStatusStoreGlobalState {
  // Pi loads each extension through jiti with moduleCache disabled, so every
  // extension can receive its own @pi/lib module instance. Keep the shared UI
  // store on globalThis so producers (Buddy) and hosts (Slab) meet in one bus.
  const root = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: SharedUiStatusStoreGlobalState
  }
  root[GLOBAL_STATE_KEY] ??= {
    store: createUiStatusStore(),
    nextGeneratedId: 1
  }
  return root[GLOBAL_STATE_KEY]
}

function newId(owner: string): UiEntryId {
  const state = sharedGlobalState()
  return `${owner}:${state.nextGeneratedId++}`
}

function lifecycle(now: number, ttlMs: number | undefined, staleAfterMs: number | undefined): UiLifecycle {
  return {
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlMs === undefined ? undefined : now + ttlMs,
    staleAfterMs
  }
}

function ordering(priority: UiPriority = 'normal', order = 0): UiOrdering {
  return { priority, order }
}

function sortStatus(a: UiStatusEntry, b: UiStatusEntry): number {
  return (
    PRIORITY_ORDER[a.ordering.priority] - PRIORITY_ORDER[b.ordering.priority] ||
    a.ordering.order - b.ordering.order ||
    a.lifecycle.createdAt - b.lifecycle.createdAt ||
    a.id.localeCompare(b.id)
  )
}

function sortWidget(a: UiWidgetEntry, b: UiWidgetEntry): number {
  return (
    a.placement.localeCompare(b.placement) ||
    PRIORITY_ORDER[a.ordering.priority] - PRIORITY_ORDER[b.ordering.priority] ||
    a.ordering.order - b.ordering.order ||
    a.lifecycle.createdAt - b.lifecycle.createdAt ||
    a.id.localeCompare(b.id)
  )
}

function isStale(life: UiLifecycle, now: number): boolean {
  if (life.expiresAt !== undefined && life.expiresAt <= now) return true
  if (life.staleAfterMs !== undefined && life.updatedAt + life.staleAfterMs <= now) return true
  return false
}

function refreshEntry<T extends UiStatusEntry | UiWidgetEntry>(entry: T, now: number): T {
  return {
    ...entry,
    lifecycle: {
      ...entry.lifecycle,
      updatedAt: now
    }
  }
}

function sameOrdering(a: UiOrdering, b: UiOrdering): boolean {
  return a.priority === b.priority && a.order === b.order
}

function sameSchedule(a: UiSchedule | undefined, b: UiSchedule | undefined): boolean {
  return a?.throttleMs === b?.throttleMs && a?.animateEveryMs === b?.animateEveryMs
}

function sameRenderableLines(a: UiWidgetEntry['content'], b: UiWidgetEntry['content']): boolean {
  if (Object.is(a, b)) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((line, index) => line === b[index])
}

function sameStatusRenderData(a: UiStatusEntry, b: UiStatusEntry): boolean {
  return (
    a.owner === b.owner &&
    a.label === b.label &&
    a.icon === b.icon &&
    Object.is(a.text, b.text) &&
    a.tone === b.tone &&
    sameOrdering(a.ordering, b.ordering) &&
    sameSchedule(a.schedule, b.schedule)
  )
}

function sameWidgetRenderData(a: UiWidgetEntry, b: UiWidgetEntry): boolean {
  return (
    a.owner === b.owner &&
    a.placement === b.placement &&
    sameRenderableLines(a.content, b.content) &&
    sameOrdering(a.ordering, b.ordering) &&
    sameSchedule(a.schedule, b.schedule)
  )
}

function makeSnapshot(
  statuses: Iterable<UiStatusEntry>,
  widgets: Iterable<UiWidgetEntry>,
  version: number
): UiSnapshot {
  return {
    statuses: [...statuses].sort(sortStatus),
    widgets: [...widgets].sort(sortWidget),
    version
  }
}

class SharedUiStatusStore implements UiStatusStoreWriter {
  private readonly statuses = new Map<UiEntryId, UiStatusEntry>()
  private readonly widgets = new Map<UiEntryId, UiWidgetEntry>()
  private readonly snapshotStore = createStore<UiSnapshot>(makeSnapshot([], [], 0))
  private version = 0

  snapshot(): UiSnapshot {
    return this.snapshotStore.get()
  }

  subscribe(listener: (snapshot: UiSnapshot) => void): UiStoreSubscription {
    const subscription: StoreSubscription = this.snapshotStore.subscribe(listener, { emitImmediately: true })
    return { unsubscribe: () => subscription.unsubscribe() }
  }

  publishStatus(entry: UiStatusEntry): UiPublicationHandle {
    const existing = this.statuses.get(entry.id)
    if (existing && sameStatusRenderData(existing, entry)) {
      this.statuses.set(entry.id, {
        ...entry,
        lifecycle: {
          ...entry.lifecycle,
          createdAt: existing.lifecycle.createdAt
        }
      })
      return this.handle(entry.id, 'status')
    }
    this.statuses.set(entry.id, entry)
    this.emit()
    return this.handle(entry.id, 'status')
  }

  publishWidget(entry: UiWidgetEntry): UiPublicationHandle {
    const existing = this.widgets.get(entry.id)
    if (existing && sameWidgetRenderData(existing, entry)) {
      this.widgets.set(entry.id, {
        ...entry,
        lifecycle: {
          ...entry.lifecycle,
          createdAt: existing.lifecycle.createdAt
        }
      })
      return this.handle(entry.id, 'widget')
    }
    this.widgets.set(entry.id, entry)
    this.emit()
    return this.handle(entry.id, 'widget')
  }

  clearOwner(owner: string): void {
    let changed = false
    for (const [id, entry] of this.statuses) {
      if (entry.owner !== owner) continue
      this.statuses.delete(id)
      changed = true
    }
    for (const [id, entry] of this.widgets) {
      if (entry.owner !== owner) continue
      this.widgets.delete(id)
      changed = true
    }
    if (changed) this.emit()
  }

  sweepStale(now = Date.now()): void {
    let changed = false
    for (const [id, entry] of this.statuses) {
      if (!isStale(entry.lifecycle, now)) continue
      this.statuses.delete(id)
      changed = true
    }
    for (const [id, entry] of this.widgets) {
      if (!isStale(entry.lifecycle, now)) continue
      this.widgets.delete(id)
      changed = true
    }
    if (changed) this.emit()
  }

  publishStatusInput(input: PublishStatusInput, now = Date.now()): UiPublicationHandle {
    const entry: UiStatusEntry = {
      id: input.id ?? newId(input.owner),
      owner: input.owner,
      label: input.label,
      icon: input.icon,
      text: input.text,
      tone: input.tone,
      ordering: ordering(input.priority, input.order),
      lifecycle: lifecycle(now, input.ttlMs, input.staleAfterMs),
      schedule: input.schedule
    }
    return this.publishStatus(entry)
  }

  publishWidgetInput(input: PublishWidgetInput, now = Date.now()): UiPublicationHandle {
    const entry: UiWidgetEntry = {
      id: input.id ?? newId(input.owner),
      owner: input.owner,
      placement: input.placement,
      content: input.content,
      ordering: ordering(input.priority, input.order),
      lifecycle: lifecycle(now, input.ttlMs, input.staleAfterMs),
      schedule: input.schedule
    }
    return this.publishWidget(entry)
  }

  private handle(id: UiEntryId, kind: 'status' | 'widget'): UiPublicationHandle {
    return {
      id,
      clear: () => this.clear(id, kind),
      refresh: (now = Date.now()) => this.refresh(id, kind, now)
    }
  }

  private clear(id: UiEntryId, kind: 'status' | 'widget'): void {
    const changed = kind === 'status' ? this.statuses.delete(id) : this.widgets.delete(id)
    if (changed) this.emit()
  }

  private refresh(id: UiEntryId, kind: 'status' | 'widget', now: number): void {
    if (kind === 'status') {
      const entry = this.statuses.get(id)
      if (!entry || entry.lifecycle.updatedAt === now) return
      this.statuses.set(id, refreshEntry(entry, now))
      this.emit()
      return
    }

    const entry = this.widgets.get(id)
    if (!entry || entry.lifecycle.updatedAt === now) return
    this.widgets.set(id, refreshEntry(entry, now))
    this.emit()
  }

  private emit(): void {
    this.version++
    this.snapshotStore.set(makeSnapshot(this.statuses.values(), this.widgets.values(), this.version))
  }
}

export function createUiStatusStore(): UiStatusStoreWriter {
  return new SharedUiStatusStore()
}

export const uiStatusStore = sharedGlobalState().store

export function getUiStatusStore(): UiStatusStore {
  return uiStatusStore
}

export function publishStatus(input: PublishStatusInput): UiPublicationHandle {
  return uiStatusStore.publishStatusInput(input)
}

export function publishWidget(input: PublishWidgetInput): UiPublicationHandle {
  return uiStatusStore.publishWidgetInput(input)
}

export function clearUiOwner(owner: string): void {
  uiStatusStore.clearOwner(owner)
}
