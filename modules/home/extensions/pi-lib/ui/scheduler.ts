import type { UiRenderClock, UiSnapshot, UiStatusStore } from './contracts.ts'

export interface ScheduledRenderHandle {
  request(): void
  flush(): void
  dispose(): void
}

export interface RenderInvalidator extends ScheduledRenderHandle {
  invalidate(): void
}

export function createRenderInvalidator(render: () => void, throttleMs = 0): RenderInvalidator {
  const scheduler = createThrottledRenderScheduler(render, throttleMs)
  return {
    ...scheduler,
    invalidate: scheduler.request
  }
}

export function createThrottledRenderScheduler(render: () => void, throttleMs: number): ScheduledRenderHandle {
  let disposed = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearTimer(): void {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  function run(): void {
    clearTimer()
    if (disposed || !pending) return
    pending = false
    render()
  }

  return {
    request() {
      if (disposed) return
      pending = true
      if (timer) return
      timer = setTimeout(run, Math.max(0, throttleMs))
      ;(timer as { unref?: () => void }).unref?.()
    },
    flush: run,
    dispose() {
      disposed = true
      pending = false
      clearTimer()
    }
  }
}

export interface IntervalHandle {
  dispose(): void
}

export function createRenderInterval(render: () => void, intervalMs: number): IntervalHandle {
  const timer = setInterval(render, Math.max(1, intervalMs))
  ;(timer as { unref?: () => void }).unref?.()
  return {
    dispose() {
      clearInterval(timer)
    }
  }
}

export interface UiRenderDriverHandle extends ScheduledRenderHandle {
  readonly clock: UiRenderClock
}

export interface UiRenderDriverOptions {
  readonly store: UiStatusStore
  readonly render: (clock: UiRenderClock, snapshot: UiSnapshot) => void
  readonly throttleMs?: number
  readonly now?: () => number
}

interface ScheduledEntry {
  readonly schedule?: {
    readonly throttleMs?: number
    readonly animateEveryMs?: number
  }
  readonly lifecycle: {
    readonly updatedAt: number
    readonly expiresAt?: number
    readonly staleAfterMs?: number
  }
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function entries(snapshot: UiSnapshot): ScheduledEntry[] {
  return [...snapshot.statuses, ...snapshot.widgets]
}

function snapshotThrottleMs(snapshot: UiSnapshot, globalThrottleMs: number): number {
  let throttleMs = Math.max(0, globalThrottleMs)
  for (const entry of entries(snapshot)) {
    const entryThrottle = positive(entry.schedule?.throttleMs)
    if (entryThrottle !== undefined) throttleMs = Math.max(throttleMs, entryThrottle)
  }
  return throttleMs
}

function snapshotAnimateEveryMs(snapshot: UiSnapshot): number | undefined {
  let animateEveryMs: number | undefined
  for (const entry of entries(snapshot)) {
    const entryInterval = positive(entry.schedule?.animateEveryMs)
    if (entryInterval === undefined) continue
    animateEveryMs = animateEveryMs === undefined ? entryInterval : Math.min(animateEveryMs, entryInterval)
  }
  return animateEveryMs
}

function snapshotNextStaleAt(snapshot: UiSnapshot): number | undefined {
  let nextAt: number | undefined
  for (const entry of entries(snapshot)) {
    const staleAt =
      entry.lifecycle.staleAfterMs === undefined ? undefined : entry.lifecycle.updatedAt + entry.lifecycle.staleAfterMs
    for (const candidate of [entry.lifecycle.expiresAt, staleAt]) {
      if (candidate === undefined) continue
      nextAt = nextAt === undefined ? candidate : Math.min(nextAt, candidate)
    }
  }
  return nextAt
}

function setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(0, delayMs))
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

function setIntervalTimer(callback: () => void, intervalMs: number): ReturnType<typeof setInterval> {
  const timer = setInterval(callback, Math.max(1, intervalMs))
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

export function createUiRenderDriver(options: UiRenderDriverOptions): UiRenderDriverHandle {
  const now = options.now ?? Date.now
  const globalThrottleMs = options.throttleMs ?? 0
  let disposed = false
  let pending = false
  let latestSnapshot = options.store.snapshot()
  let clock: UiRenderClock = { now: now(), tick: 0 }
  let lastRenderAt = Number.NEGATIVE_INFINITY
  let renderTimer: ReturnType<typeof setTimeout> | undefined
  let staleTimer: ReturnType<typeof setTimeout> | undefined
  let animationTimer: ReturnType<typeof setInterval> | undefined
  let animationEveryMs: number | undefined

  function clearRenderTimer(): void {
    if (!renderTimer) return
    clearTimeout(renderTimer)
    renderTimer = undefined
  }

  function clearStaleTimer(): void {
    if (!staleTimer) return
    clearTimeout(staleTimer)
    staleTimer = undefined
  }

  function clearAnimationTimer(): void {
    if (!animationTimer) return
    clearInterval(animationTimer)
    animationTimer = undefined
    animationEveryMs = undefined
  }

  function renderThrottleMs(): number {
    return snapshotThrottleMs(latestSnapshot, globalThrottleMs)
  }

  function scheduleRender(): void {
    if (disposed || renderTimer) return
    const delayMs = Math.max(0, lastRenderAt + renderThrottleMs() - now())
    renderTimer = setTimer(flush, delayMs)
  }

  function request(): void {
    if (disposed) return
    pending = true
    scheduleRender()
  }

  function flush(): void {
    clearRenderTimer()
    if (disposed || !pending) return
    pending = false
    const renderNow = now()
    lastRenderAt = renderNow
    clock = { now: renderNow, tick: clock.tick + 1 }
    options.render(clock, latestSnapshot)
  }

  function sweep(nowMs = now()): boolean {
    const beforeVersion = options.store.snapshot().version
    options.store.sweepStale(nowMs)
    latestSnapshot = options.store.snapshot()
    return latestSnapshot.version !== beforeVersion
  }

  function scheduleStaleSweep(): void {
    clearStaleTimer()
    const nextStaleAt = snapshotNextStaleAt(latestSnapshot)
    if (nextStaleAt === undefined || disposed) return
    staleTimer = setTimer(() => {
      const changed = sweep()
      if (changed) request()
      rescheduleTimers()
    }, nextStaleAt - now())
  }

  function scheduleAnimation(): void {
    const nextAnimationEveryMs = snapshotAnimateEveryMs(latestSnapshot)
    if (nextAnimationEveryMs === animationEveryMs) return
    clearAnimationTimer()
    if (nextAnimationEveryMs === undefined || disposed) return
    animationEveryMs = nextAnimationEveryMs
    animationTimer = setIntervalTimer(() => {
      sweep()
      request()
      rescheduleTimers()
    }, nextAnimationEveryMs)
  }

  function rescheduleTimers(): void {
    scheduleStaleSweep()
    scheduleAnimation()
  }

  const subscription = options.store.subscribe((snapshot) => {
    latestSnapshot = snapshot
    rescheduleTimers()
    request()
  })

  rescheduleTimers()

  return {
    get clock() {
      return clock
    },
    request,
    flush,
    dispose() {
      disposed = true
      pending = false
      subscription.unsubscribe()
      clearRenderTimer()
      clearStaleTimer()
      clearAnimationTimer()
    }
  }
}
