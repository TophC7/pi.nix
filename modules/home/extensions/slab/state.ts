import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { UiRenderClock, UiSnapshot } from '@pi/lib/ui'
import { displayDirectory, shortenModel } from './format.ts'
import { emptyGitSnapshot } from './git.ts'
import type { SlabConfig, SlabGitSnapshot, SlabRuntimeState, SlabUsageTotals } from './types.ts'

interface UsageLike {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: {
    total?: number
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function usageCost(usage: UsageLike | undefined): number {
  const cost = usage?.cost
  if (!cost) return 0
  if (Number.isFinite(cost.total)) return cost.total ?? 0
  return usageNumber(cost.input) + usageNumber(cost.output) + usageNumber(cost.cacheRead) + usageNumber(cost.cacheWrite)
}

function entryUsage(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const record = entry as { type?: unknown; message?: unknown; usage?: UsageLike }
  if (record.type === 'branch_summary' || record.type === 'compaction') return record.usage
  if (record.type !== 'message' || !record.message || typeof record.message !== 'object') return undefined
  const message = record.message as { role?: unknown; usage?: UsageLike }
  return message.role === 'assistant' || message.role === 'toolResult' ? message.usage : undefined
}

interface SessionManagerView {
  getEntries?: () => readonly unknown[]
  getLeafId?: () => string | null | undefined
}

type ContextUsage = ReturnType<ExtensionContext['getContextUsage']>

interface SessionCache {
  usage?: { leafId: string; totals: SlabUsageTotals }
  context?: { leafId: string; model: string; usage: ContextUsage }
}

const sessionCaches = new WeakMap<SessionManagerView, SessionCache>()

function sessionManager(ctx: ExtensionContext): SessionManagerView {
  return ctx.sessionManager as unknown as SessionManagerView
}

function sessionCache(manager: SessionManagerView): SessionCache {
  const cached = sessionCaches.get(manager)
  if (cached) return cached
  const created: SessionCache = {}
  sessionCaches.set(manager, created)
  return created
}

function contextUsage(ctx: ExtensionContext): ContextUsage {
  const manager = sessionManager(ctx)
  const leafId = manager.getLeafId?.()
  if (typeof leafId !== 'string') return ctx.getContextUsage()

  const model = modelCacheKey(ctx.model)
  const cached = sessionCaches.get(manager)?.context
  if (cached?.leafId === leafId && cached.model === model) return cached.usage

  const usage = ctx.getContextUsage()
  sessionCache(manager).context = { leafId, model, usage }
  return usage
}

export function computeUsageTotals(ctx: ExtensionContext): SlabUsageTotals {
  const manager = sessionManager(ctx)
  const leafId = manager.getLeafId?.()
  const cached = sessionCaches.get(manager)?.usage
  if (typeof leafId === 'string' && cached?.leafId === leafId) return cached.totals
  const usage: SlabUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0
  }
  for (const entry of manager.getEntries?.() ?? []) {
    const item = entryUsage(entry)
    if (!item) continue
    usage.input += usageNumber(item.input)
    usage.output += usageNumber(item.output)
    usage.cacheRead += usageNumber(item.cacheRead)
    usage.cacheWrite += usageNumber(item.cacheWrite)
    usage.cost += usageCost(item)
  }
  if (typeof leafId === 'string') sessionCache(manager).usage = { leafId, totals: usage }
  return usage
}

function provider(model: ExtensionContext['model']): string | undefined {
  const value = (model as { provider?: unknown } | undefined)?.provider
  return typeof value === 'string' ? value : undefined
}

function modelId(model: ExtensionContext['model']): string | undefined {
  const value = model?.id
  return typeof value === 'string' ? value : undefined
}

function modelCacheKey(model: ExtensionContext['model']): string {
  return `${provider(model) ?? ''}\0${modelId(model) ?? ''}\0${contextWindow(model)}`
}

function contextWindow(model: ExtensionContext['model']): number {
  const value = (model as { contextWindow?: unknown } | undefined)?.contextWindow
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export interface CreateSlabRuntimeStateOptions {
  readonly git?: SlabGitSnapshot
  readonly thinking?: string
  readonly providerCount?: number
}

export function createSlabRuntimeState(
  ctx: ExtensionContext,
  snapshot: UiSnapshot,
  clock: UiRenderClock,
  config: SlabConfig,
  options: CreateSlabRuntimeStateOptions = {}
): SlabRuntimeState {
  const cwd = ctx.cwd
  const currentContextUsage = contextUsage(ctx)
  const id = modelId(ctx.model)
  return {
    workspace: {
      name: displayDirectory(cwd),
      path: cwd
    },
    git: options.git ?? emptyGitSnapshot('unknown', clock.now),
    providers: {
      availableCount: options.providerCount ?? 1
    },
    model: {
      id,
      provider: provider(ctx.model),
      displayName: shortenModel(id, config.model.customNames),
      thinking: options.thinking ?? 'off'
    },
    context: {
      tokens: currentContextUsage?.tokens ?? null,
      window: currentContextUsage?.contextWindow ?? contextWindow(ctx.model),
      percent: currentContextUsage?.percent ?? null
    },
    usage: computeUsageTotals(ctx),
    statuses: snapshot.statuses,
    version: snapshot.version
  }
}
