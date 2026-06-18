import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { restoreMainRuntimeProfile, type MainRuntimeRestoreState } from '@pi/lib/runtime-profile'

const pendingQaRestores = new WeakMap<ExtensionAPI, Map<string, MainRuntimeRestoreState>>()
const restoreLifecycleRegistered = new WeakSet<ExtensionAPI>()
const restoreAbortListeners = new WeakMap<ExtensionAPI, { readonly signal: AbortSignal; readonly listener: () => void }>()

export function registerQaModelRestoreLifecycle(pi: ExtensionAPI): void {
  if (restoreLifecycleRegistered.has(pi)) return
  restoreLifecycleRegistered.add(pi)

  pi.on('agent_start', async (_event, ctx) => {
    const signal = ctx.signal
    if (!signal || !pendingQaRestores.has(pi)) return
    if (signal.aborted) {
      clearQaRestoreAbortListener(pi)
      await restoreAllPendingQaConfig(pi, ctx)
      return
    }

    const existing = restoreAbortListeners.get(pi)
    if (existing?.signal === signal) return
    clearQaRestoreAbortListener(pi)

    const listener = () => {
      clearQaRestoreAbortListener(pi)
      void restoreAllPendingQaConfig(pi, ctx).catch((error) => {
        notifyQaRestoreFailure(ctx, error)
      })
    }
    restoreAbortListeners.set(pi, { signal, listener })
    signal.addEventListener('abort', listener, { once: true })
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    await restoreAllPendingQaConfig(pi, ctx)
  })
}

export function deferQaRestoreUntilFinish(pi: ExtensionAPI, runId: string, restore: MainRuntimeRestoreState): void {
  let restores = pendingQaRestores.get(pi)
  if (!restores) {
    restores = new Map()
    pendingQaRestores.set(pi, restores)
  }
  restores.set(runId, restores.values().next().value ?? restore)
}

export async function restoreQaConfigForRun(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, 'ui'>,
  runId: string
): Promise<boolean> {
  const restores = pendingQaRestores.get(pi)
  const restore = restores?.get(runId)
  if (!restores || !restore) return false

  restores.delete(runId)
  if (restores.size === 0) {
    pendingQaRestores.delete(pi)
    clearQaRestoreAbortListener(pi)
  }

  await restoreMainRuntimeProfile(pi, restore)
  ctx.ui.notify('/qa config restored', 'info')
  return true
}

export async function restoreAllPendingQaConfig(pi: ExtensionAPI, ctx: Pick<ExtensionContext, 'ui'>): Promise<boolean> {
  const restores = pendingQaRestores.get(pi)
  const restore = restores?.values().next().value
  if (!restores || !restore) return false

  pendingQaRestores.delete(pi)
  clearQaRestoreAbortListener(pi)
  await restoreMainRuntimeProfile(pi, restore)
  ctx.ui.notify('/qa config restored', 'info')
  return true
}

function clearQaRestoreAbortListener(pi: ExtensionAPI): void {
  const existing = restoreAbortListeners.get(pi)
  if (!existing) return
  existing.signal.removeEventListener('abort', existing.listener)
  restoreAbortListeners.delete(pi)
}

function notifyQaRestoreFailure(ctx: Pick<ExtensionContext, 'ui'>, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  ctx.ui.notify(`/qa config restore failed: ${message}`, 'error')
}
