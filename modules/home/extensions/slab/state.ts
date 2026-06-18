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
  const record = entry as { type?: unknown; message?: unknown }
  if (record.type !== 'message' || !record.message || typeof record.message !== 'object') return undefined
  const message = record.message as { role?: unknown; usage?: UsageLike }
  if (message.role !== 'assistant') return undefined
  return message.usage
}

let cachedEntries: unknown[] | undefined
let cachedUsage: SlabUsageTotals | undefined

function sessionEntries(ctx: ExtensionContext): readonly unknown[] {
  const manager = ctx.sessionManager as unknown as {
    getEntries?: () => readonly unknown[]
  }
  return manager.getEntries?.() ?? []
}

export function computeUsageTotals(ctx: ExtensionContext): SlabUsageTotals {
  const entries = sessionEntries(ctx)
  if (Object.is(entries, cachedEntries) && cachedUsage) return cachedUsage
  const usage: SlabUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0
  }
  for (const entry of entries) {
    const item = entryUsage(entry)
    if (!item) continue
    usage.input += usageNumber(item.input)
    usage.output += usageNumber(item.output)
    usage.cacheRead += usageNumber(item.cacheRead)
    usage.cacheWrite += usageNumber(item.cacheWrite)
    usage.cost += usageCost(item)
  }
  cachedEntries = entries as unknown[]
  cachedUsage = usage
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
  const contextUsage = ctx.getContextUsage()
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
      tokens: contextUsage?.tokens ?? null,
      window: contextUsage?.contextWindow ?? contextWindow(ctx.model),
      percent: contextUsage?.percent ?? null
    },
    usage: computeUsageTotals(ctx),
    statuses: snapshot.statuses,
    version: snapshot.version
  }
}
