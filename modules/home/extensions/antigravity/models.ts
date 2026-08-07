// AGY bakes reasoning effort into the model slug, and rejects --effort when a
// suffixed slug is given ("--model gemini-3.6-flash-low conflicts with
// --effort=medium"). So Pi declares one model per slug *family*, and the
// active thinking level selects the suffix at spawn time.
//
// Levels a family does not have are mapped to null so Pi hides them instead of
// silently substituting a different slug. Run `agy models` after a CLI upgrade
// and reconcile this table.

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type Family = {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** Pi thinking level -> AGY slug. null marks the level unsupported. */
  slugs: Partial<Record<ThinkingLevel, string | null>>
}

const ONE_MILLION = 1_000_000
const TWO_HUNDRED_K = 200_000
const ONE_TWENTY_EIGHT_K = 128_000

// Context/output sizes are not exposed by `agy models`; these track the
// published model limits. They only steer Pi's compaction thresholds, so a
// conservative value degrades gracefully.
const FAMILIES: Family[] = [
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    contextWindow: ONE_MILLION,
    maxTokens: 65_536,
    slugs: {
      minimal: 'gemini-3.6-flash-low',
      low: 'gemini-3.6-flash-low',
      medium: 'gemini-3.6-flash-medium',
      high: 'gemini-3.6-flash-high',
      xhigh: null,
      max: null
    }
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    contextWindow: ONE_MILLION,
    maxTokens: 65_536,
    slugs: {
      minimal: 'gemini-3.5-flash-low',
      low: 'gemini-3.5-flash-low',
      medium: 'gemini-3.5-flash-medium',
      high: 'gemini-3.5-flash-high',
      xhigh: null,
      max: null
    }
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    contextWindow: ONE_MILLION,
    maxTokens: 65_536,
    slugs: {
      minimal: 'gemini-3.1-pro-low',
      low: 'gemini-3.1-pro-low',
      medium: null,
      high: 'gemini-3.1-pro-high',
      xhigh: null,
      max: null
    }
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextWindow: TWO_HUNDRED_K,
    maxTokens: 65_536,
    slugs: { high: 'claude-sonnet-4-6' }
  },
  {
    id: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6 (Thinking)',
    contextWindow: TWO_HUNDRED_K,
    maxTokens: 65_536,
    slugs: { high: 'claude-opus-4-6-thinking' }
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    contextWindow: ONE_TWENTY_EIGHT_K,
    maxTokens: 32_768,
    slugs: { medium: 'gpt-oss-120b-medium' }
  }
]

const BY_ID = new Map(FAMILIES.map((family) => [family.id, family]))

export function buildModels() {
  return FAMILIES.map((family) => ({
    id: family.id,
    name: family.name,
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    contextWindow: family.contextWindow,
    maxTokens: family.maxTokens,
    // Subscription usage is not billed per token, and AGY exposes no
    // authoritative rate. Usage is still reported; cost stays zero.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: Object.fromEntries(
      Object.entries(family.slugs).map(([level, slug]) => [level, slug === null ? null : level])
    )
  }))
}

/**
 * Resolve the AGY slug for a Pi model plus the turn's thinking level. An
 * explicit level must be configured for the family — an unknown or unsupported
 * level throws rather than silently selecting a different slug. Only an
 * omitted level falls back to the strongest configured slug.
 */
export function agyModelSlug(modelId: string, level: string | undefined): string {
  const family = BY_ID.get(modelId)
  if (!family) throw new Error(`Unsupported Antigravity model: ${modelId}`)

  if (level === undefined) {
    const slug = fallbackSlug(family)
    if (!slug) throw new Error(`Antigravity model ${modelId} has no usable reasoning level`)
    return slug
  }
  const configured = family.slugs[level as ThinkingLevel]
  if (typeof configured !== 'string') {
    throw new Error(`Antigravity model ${modelId} does not support reasoning level ${level}`)
  }
  return configured
}

function fallbackSlug(family: Family): string | undefined {
  for (const level of ['high', 'medium', 'low'] as const) {
    const slug = family.slugs[level]
    if (slug) return slug
  }
  return undefined
}
