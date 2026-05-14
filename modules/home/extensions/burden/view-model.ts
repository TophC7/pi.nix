import type { BurdenEntry, BurdenGap, BurdenReport, BurdenSectionKind, BurdenSourceRef } from './types.ts'

export interface BurdenSourceView {
  readonly kind: BurdenSourceRef['kind']
  readonly label: string
  readonly path?: string
  readonly name?: string
}

export interface BurdenSnapshotView {
  readonly suggestedName: string
  readonly metadata: {
    readonly rowId: string
    readonly entryId: string
    readonly label: string
    readonly sourceLabel: string
    readonly tokens: number
    readonly chars: number
  }
  readonly content: string
}

export interface BurdenRowActions {
  readonly openSource?: {
    readonly path: string
  }
  readonly openSnapshot?: BurdenSnapshotView
}

export interface BurdenRowView {
  readonly id: string
  readonly entryId: string
  readonly parentId?: string
  readonly depth: number
  readonly label: string
  readonly kind: BurdenSectionKind
  readonly tokens: number
  readonly chars: number
  readonly percentOfTotal: number
  readonly source?: BurdenSourceView
  readonly sourceLabel: string
  readonly hasChildren: boolean
  readonly childIds: readonly string[]
  readonly hasGeneratedContent: boolean
  readonly searchText: string
  readonly actions: BurdenRowActions
  readonly entry: BurdenEntry
}

export interface BurdenSectionView {
  readonly id: string
  readonly label: string
  readonly kind: BurdenSectionKind
  readonly tokens: number
  readonly chars: number
  readonly percentOfTotal: number
  readonly rowId: string
}

export interface BurdenGapView {
  readonly id: string
  readonly label: string
  readonly reason: string
  readonly tokens: number
  readonly chars: number
  readonly percentOfTotal: number
  readonly searchText: string
}

export interface BurdenViewModel {
  readonly generatedAt: string
  readonly totalTokens: number
  readonly totalChars: number
  readonly contextWindow?: number
  readonly contextPercent?: number
  readonly sections: readonly BurdenSectionView[]
  readonly rows: readonly BurdenRowView[]
  readonly gaps: readonly BurdenGapView[]
  readonly rowOrder: readonly string[]
  readonly rowsById: ReadonlyMap<string, BurdenRowView>
}

/**
 * Adapts BurdenReport for UI without changing buildBurdenReport().
 *
 * Row order is deterministic preorder: top-level report.sections order, then each
 * entry's children order. Gap order follows report.gaps order.
 */
export function buildBurdenViewModel(report: BurdenReport): BurdenViewModel {
  const rows: BurdenRowView[] = []
  const rowsById = new Map<string, BurdenRowView>()

  const visit = (entry: BurdenEntry, depth: number, ancestry: readonly string[], parentId?: string): BurdenRowView => {
    const id = rowIdFor(entry, ancestry)
    const childIds = (entry.children ?? []).map((child, index) =>
      rowIdFor(child, [...ancestry, entry.id, String(index)])
    )
    const row = rowView(entry, id, parentId, depth, childIds, report.totalTokens)
    rows.push(row)
    rowsById.set(id, row)
    entry.children?.forEach((child, index) => visit(child, depth + 1, [...ancestry, entry.id, String(index)], id))
    return row
  }

  const sections = report.sections.map((section, index) => {
    const row = visit(section, 0, [String(index)])
    return {
      id: section.id,
      label: section.label,
      kind: section.kind,
      tokens: section.tokens,
      chars: section.chars,
      percentOfTotal: percent(section.tokens, report.totalTokens),
      rowId: row.id
    }
  })

  return {
    generatedAt: report.generatedAt,
    totalTokens: report.totalTokens,
    totalChars: report.totalChars,
    contextWindow: report.contextWindow,
    contextPercent: report.contextWindow ? percent(report.totalTokens, report.contextWindow) : undefined,
    sections,
    rows,
    gaps: report.gaps.map((gap, index) => gapView(gap, index, report.totalTokens)),
    rowOrder: rows.map((row) => row.id),
    rowsById
  }
}

function rowView(
  entry: BurdenEntry,
  id: string,
  parentId: string | undefined,
  depth: number,
  childIds: readonly string[],
  totalTokens: number
): BurdenRowView {
  const source = sourceView(entry.source)
  const sourceLabel = source?.label ?? labelForKind(entry.kind)
  const snapshot = snapshotView(entry, id, sourceLabel)
  const actions: BurdenRowActions = {
    openSource: entry.source?.path ? { path: entry.source.path } : undefined,
    openSnapshot: snapshot
  }
  return {
    id,
    entryId: entry.id,
    parentId,
    depth,
    label: entry.label,
    kind: entry.kind,
    tokens: entry.tokens,
    chars: entry.chars,
    percentOfTotal: percent(entry.tokens, totalTokens),
    source,
    sourceLabel,
    hasChildren: childIds.length > 0,
    childIds,
    hasGeneratedContent: typeof entry.content === 'string' && entry.content.length > 0,
    searchText: searchText(entry, sourceLabel),
    actions,
    entry
  }
}

function sourceView(source: BurdenSourceRef | undefined): BurdenSourceView | undefined {
  if (!source) return undefined
  return {
    kind: source.kind,
    label: sourceLabel(source),
    path: source.path,
    name: source.name
  }
}

function sourceLabel(source: BurdenSourceRef): string {
  if (source.path && source.name) return `${source.name} — ${source.path}`
  if (source.path) return source.path
  if (source.name) return `${source.kind}:${source.name}`
  return source.kind
}

function snapshotView(entry: BurdenEntry, rowId: string, sourceLabel: string): BurdenSnapshotView | undefined {
  if (typeof entry.content !== 'string' || entry.content.length === 0) return undefined
  return {
    suggestedName: `${safeName(entry.id || entry.label)}.md`,
    metadata: {
      rowId,
      entryId: entry.id,
      label: entry.label,
      sourceLabel,
      tokens: entry.tokens,
      chars: entry.chars
    },
    content: entry.content
  }
}

function gapView(gap: BurdenGap, index: number, totalTokens: number): BurdenGapView {
  return {
    id: `gap:${index}`,
    label: gap.label,
    reason: gap.reason,
    tokens: gap.tokens,
    chars: gap.chars,
    percentOfTotal: percent(gap.tokens, totalTokens),
    searchText: [gap.label, gap.reason, gap.tokens, gap.chars].join(' ')
  }
}

function searchText(entry: BurdenEntry, sourceLabel: string): string {
  return [
    entry.id,
    entry.label,
    entry.kind,
    entry.tokens,
    entry.chars,
    sourceLabel,
    entry.source?.name,
    entry.source?.path,
    entry.content
  ]
    .filter(Boolean)
    .join(' ')
}

function rowIdFor(entry: BurdenEntry, ancestry: readonly string[]): string {
  return `row:${[...ancestry, entry.id].map(safeName).join(':')}`
}

function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-|-$/g, '') || 'row'
  )
}

function labelForKind(kind: BurdenSectionKind): string {
  switch (kind) {
    case 'base-prompt':
      return 'base prompt'
    case 'custom-system-prompt':
      return 'custom system prompt'
    case 'agents':
      return 'agent context'
    case 'skills':
      return 'skill prompt'
    case 'tools':
      return 'tool definition'
    case 'metadata':
      return 'metadata'
    case 'unknown':
      return 'unknown attribution'
  }
}

function percent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0
  return value / total
}
