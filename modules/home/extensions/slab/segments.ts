import { stripControls } from '@pi/lib/ui'
import { formatCost, formatPercent, formatTokens } from './format.ts'
import { GIT_CONFLICT_MARK, GIT_DIRTY_MARK, SLAB_ICONS } from './palette.ts'
import type {
  SlabSegmentData,
  SlabSegmentDefinition,
  SlabSegmentRenderContext,
  SlabSegmentRenderResult
} from './types.ts'

function displayForMode(data: SlabSegmentData, widthMode: SlabSegmentRenderContext['widthMode']): string {
  const configured = data.display?.[widthMode]
  if (configured !== undefined) return configured
  const secondary = data.secondary ? ` ${data.secondary}` : ''
  return `${data.primary}${secondary}`.trim()
}

function renderCollectedSegment(
  ctx: SlabSegmentRenderContext,
  segment: SlabSegmentDefinition,
  data: SlabSegmentData
): SlabSegmentRenderResult {
  const icon = ctx.render.unicode ? SLAB_ICONS[segment.id] : ''
  const value = displayForMode(data, ctx.widthMode)
  const prefix = icon ? `${icon} ` : ''
  return {
    id: segment.id,
    text: `${prefix}${value}`.trim()
  }
}

function gitBranchLabel(ctx: SlabSegmentRenderContext): string {
  const git = ctx.state.git
  if (git.branch) return git.branch
  return 'HEAD'
}

function gitStatusMark(ctx: SlabSegmentRenderContext): string {
  const status = ctx.state.git.status
  if (status === 'conflict') return GIT_CONFLICT_MARK
  if (status === 'dirty') return GIT_DIRTY_MARK
  return ''
}

function gitDetailParts(ctx: SlabSegmentRenderContext): string[] {
  const git = ctx.state.git
  const parts: string[] = []
  const status = gitStatusMark(ctx)
  if (status && (ctx.config.git.showDirty || git.status === 'conflict')) parts.push(status)
  if (ctx.config.git.showAheadBehind) {
    if (git.ahead > 0) parts.push(`↑${git.ahead}`)
    if (git.behind > 0) parts.push(`↓${git.behind}`)
  }
  return parts
}

function contextTokenRatio(ctx: SlabSegmentRenderContext): string {
  return `${formatTokens(ctx.state.context.tokens)}/${formatTokens(ctx.state.context.window)}`
}

function contextIsUnknown(ctx: SlabSegmentRenderContext): boolean {
  return ctx.state.context.percent === null && ctx.state.context.tokens === null
}

function contextDisplayValue(ctx: SlabSegmentRenderContext): string {
  const pct = formatPercent(ctx.state.context.percent)
  const ratio = contextTokenRatio(ctx)
  if (ctx.config.context.display === 'percent') return pct
  if (ctx.config.context.display === 'tokens') return ratio
  return `${pct} ${ratio}`
}

function contextCompactValue(ctx: SlabSegmentRenderContext): string {
  if (ctx.config.context.display === 'tokens') return contextTokenRatio(ctx)
  return formatPercent(ctx.state.context.percent)
}

function shouldShowThinking(ctx: SlabSegmentRenderContext, thinking: string): boolean {
  if (ctx.config.model.showThinking === 'never') return false
  if (ctx.config.model.showThinking === 'always') return Boolean(thinking)
  return thinking !== 'off' && ctx.widthMode !== 'minimal'
}

function shouldShowTokenCache(ctx: SlabSegmentRenderContext): boolean {
  if (ctx.config.tokens.cache === 'hide') return false
  if (ctx.config.tokens.cache === 'show') return true
  return ctx.widthMode === 'full'
}

function tokenCacheParts(ctx: SlabSegmentRenderContext): string[] {
  if (!shouldShowTokenCache(ctx)) return []
  const usage = ctx.state.usage
  const parts: string[] = []
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
  return parts
}

function tokenPrimary(ctx: SlabSegmentRenderContext): string {
  const usage = ctx.state.usage
  if (ctx.config.tokens.display === 'total') return `total ${formatTokens(usage.input + usage.output)}`
  return `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`
}

function statusText(ctx: SlabSegmentRenderContext): string[] {
  const width = Math.max(10, Math.floor(ctx.render.width / 3))
  return ctx.state.statuses
    .map((entry) => {
      const raw =
        typeof entry.text === 'function'
          ? entry.text({
              width,
              capabilities: ctx.render,
              now: ctx.render.now,
              tick: ctx.render.tick
            })
          : entry.text
      const text = stripControls(raw).trim()
      if (!text) return ''
      const labelled = entry.label ? `${entry.label}: ${text}` : text
      const icon = ctx.render.unicode && entry.icon ? `${entry.icon} ` : ''
      return `${icon}${labelled}`.trim()
    })
    .filter(Boolean)
}

const SEGMENTS: SlabSegmentDefinition[] = [
  {
    id: 'git',
    label: 'Git',
    collect(ctx) {
      const git = ctx.state.git
      if (!git.repo) return undefined
      const branch = gitBranchLabel(ctx)
      const parts = gitDetailParts(ctx)
      const secondary = parts.join(' ') || undefined
      const minimalStatus = git.status === 'conflict' || ctx.config.git.showDirty ? gitStatusMark(ctx) : ''
      return {
        primary: branch,
        secondary,
        display: {
          minimal: [branch, minimalStatus].filter(Boolean).join(' ')
        }
      }
    }
  },
  {
    id: 'context',
    label: 'Context',
    collect(ctx) {
      if (ctx.config.context.unknown === 'hide' && contextIsUnknown(ctx)) return undefined
      const primary =
        ctx.config.context.display === 'tokens' ? contextTokenRatio(ctx) : formatPercent(ctx.state.context.percent)
      const secondary = ctx.config.context.display === 'percent+tokens' ? contextTokenRatio(ctx) : undefined
      const compact = contextCompactValue(ctx)
      return {
        primary,
        secondary,
        display: {
          full: contextDisplayValue(ctx),
          compact,
          minimal: compact
        }
      }
    }
  },
  {
    id: 'cost',
    label: 'Cost',
    collect(ctx) {
      if (ctx.config.cost.hideZero && (!Number.isFinite(ctx.state.usage.cost) || ctx.state.usage.cost <= 0))
        return undefined
      return { primary: formatCost(ctx.state.usage.cost) }
    }
  },
  {
    id: 'tokens',
    label: 'Tokens',
    collect(ctx) {
      const primary = tokenPrimary(ctx)
      const cacheParts = tokenCacheParts(ctx)
      return {
        primary,
        secondary: cacheParts.join(' ') || undefined,
        display: {
          full: [primary, ...cacheParts].join(' '),
          compact: [primary, ...cacheParts].join(' '),
          minimal: [primary, ...cacheParts].join(' ')
        }
      }
    }
  },
  {
    id: 'status',
    label: 'Status',
    collect(ctx) {
      const statuses = statusText(ctx)
      if (statuses.length === 0) return undefined
      return { primary: statuses.join(' · ') }
    }
  },
  {
    id: 'model',
    label: 'Model',
    collect(ctx) {
      let model = ctx.state.model.displayName || ctx.state.model.id || 'no-model'
      if (ctx.showProvider && ctx.state.model.provider) model = `${ctx.state.model.provider}/${model}`
      const thinking = ctx.state.model.thinking || 'off'
      const visibleThinking = shouldShowThinking(ctx, thinking) ? thinking : ''
      return {
        primary: model,
        secondary: visibleThinking || undefined,
        display: {
          full: visibleThinking ? `${model} ${visibleThinking}` : model,
          compact: visibleThinking ? `${model} ${visibleThinking}` : model,
          minimal: visibleThinking ? `${model} ${visibleThinking}` : model
        }
      }
    }
  }
]

export function renderSegment(
  ctx: SlabSegmentRenderContext,
  segment: SlabSegmentDefinition
): SlabSegmentRenderResult | undefined {
  const data = segment.collect(ctx)
  return data ? renderCollectedSegment(ctx, segment, data) : undefined
}

export const SLAB_SEGMENT_BY_ID = new Map(SEGMENTS.map((segment) => [segment.id, segment]))
