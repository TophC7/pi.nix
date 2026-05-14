import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import type { BurdenEntry, BurdenGap, BurdenReport, BurdenSectionKind, BurdenSourceRef } from './types.ts'

interface ToolLike {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
  readonly sourceInfo?: {
    readonly path?: string
    readonly source?: string
  }
}

interface PromptRange {
  readonly start: number
  readonly end: number
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

function entry(
  id: string,
  label: string,
  kind: BurdenSectionKind,
  content: string,
  extra: Partial<Pick<BurdenEntry, 'source' | 'children'>> = {}
): BurdenEntry {
  return {
    id,
    label,
    kind,
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    ...extra
  }
}

function syntheticEntry(
  id: string,
  label: string,
  kind: BurdenSectionKind,
  tokens: number,
  chars: number,
  extra: Partial<Pick<BurdenEntry, 'source' | 'children' | 'content'>> = {}
): BurdenEntry {
  return { id, label, kind, tokens, chars, ...extra }
}

function firstPositive(...values: number[]): number {
  let min = -1
  for (const value of values) {
    if (value >= 0 && (min < 0 || value < min)) min = value
  }
  return min
}

function findBaseEnd(prompt: string, projectContext: number, skills: number, metadata: number): number {
  const marker = /^- (?:Always read pi|When working on pi).+$/gm
  let last = -1
  for (const match of prompt.matchAll(marker)) last = match.index + match[0].length
  if (last >= 0) return last
  return firstPositive(projectContext, skills, metadata)
}

function parseAgents(contextBlock: string): readonly BurdenEntry[] {
  const headingPattern = /^## (\/.+)$/gm
  const matches = [...contextBlock.matchAll(headingPattern)]
  return matches.map((match, index) => {
    const path = match[1] ?? 'Unknown AGENTS.md'
    const start = match.index
    const end = index + 1 < matches.length ? matches[index + 1]!.index : contextBlock.length
    const content = contextBlock.slice(start, end)
    return entry(`agents:${path}`, path, 'agents', content, {
      source: { kind: 'file', path }
    })
  })
}

function parseSkills(skillsBlock: string): readonly BurdenEntry[] {
  const skillPattern = /<skill>([\s\S]*?)<\/skill>/g
  const namePattern = /<name>([\s\S]*?)<\/name>/
  const descPattern = /<description>([\s\S]*?)<\/description>/
  const locationPattern = /<location>([\s\S]*?)<\/location>/
  return [...skillsBlock.matchAll(skillPattern)].map((match, index) => {
    const full = match[0]
    const inner = match[1] ?? ''
    const name = inner.match(namePattern)?.[1]?.trim() || `skill ${index + 1}`
    const description = inner.match(descPattern)?.[1]?.trim()
    const path = inner.match(locationPattern)?.[1]?.trim()
    return entry(`skill:${name}`, name, 'skills', full, {
      source: { kind: 'skill', name, path },
      children: description
        ? [
            syntheticEntry(
              `skill:${name}:description`,
              'description',
              'skills',
              estimateTokens(description),
              description.length
            )
          ]
        : undefined
    })
  })
}

function toolContent(tool: ToolLike): string {
  return JSON.stringify(
    {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? {}
    },
    null,
    2
  )
}

function toolSource(tool: ToolLike): BurdenSourceRef {
  const path = tool.sourceInfo?.path
  if (path) return { kind: 'tool', name: tool.name, path }
  return { kind: 'unknown', name: tool.name }
}

function buildToolSection(pi: ExtensionAPI, gaps: BurdenGap[]): BurdenEntry | undefined {
  const tools = pi.getAllTools() as ToolLike[]
  if (tools.length === 0) return undefined
  const active = new Set(pi.getActiveTools())
  const activeTools = tools.filter((tool) => active.has(tool.name))
  const inactiveTools = tools.filter((tool) => !active.has(tool.name))
  const children = activeTools.map((tool) => {
    const content = toolContent(tool)
    const source = toolSource(tool)
    if (source.kind === 'unknown') {
      gaps.push({
        label: `Tool source: ${tool.name}`,
        reason: 'Pi did not expose a source path for this tool.',
        tokens: estimateTokens(content),
        chars: content.length
      })
    }
    return entry(`tool:${tool.name}`, tool.name, 'tools', content, { source })
  })
  const tokens = children.reduce((sum, child) => sum + child.tokens, 0)
  const chars = children.reduce((sum, child) => sum + child.chars, 0)
  return syntheticEntry(
    'tools',
    `Tool definitions (${activeTools.length} active, ${tools.length} total; ${inactiveTools.length} inactive)`,
    'tools',
    tokens,
    chars,
    { children }
  )
}

function uncoveredPromptGaps(prompt: string, ranges: readonly PromptRange[]): string[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  let cursor = 0
  const gaps: string[] = []
  for (const range of sorted) {
    if (range.start > cursor) {
      const text = prompt.slice(cursor, range.start).trim()
      if (text) gaps.push(text)
    }
    cursor = Math.max(cursor, range.end)
  }
  const tail = prompt.slice(cursor).trim()
  if (tail) gaps.push(tail)
  return gaps
}

export function buildBurdenReport(pi: ExtensionAPI, ctx: ExtensionContext): BurdenReport {
  const prompt = ctx.getSystemPrompt()
  const sections: BurdenEntry[] = []
  const ranges: PromptRange[] = []
  const gaps: BurdenGap[] = []

  const projectContextIdx = prompt.indexOf('\n\n# Project Context\n')
  const skillsPreambleIdx = prompt.indexOf('\n\nThe following skills provide specialized instructions')
  const availableSkillsStart = prompt.indexOf('<available_skills>')
  const availableSkillsEnd = prompt.indexOf('</available_skills>')
  const metadataIdx = prompt.lastIndexOf('\nCurrent date')
  const baseEnd = findBaseEnd(prompt, projectContextIdx, skillsPreambleIdx, metadataIdx)

  if (baseEnd > 0) {
    sections.push(
      entry('base', 'Base prompt', 'base-prompt', prompt.slice(0, baseEnd), {
        source: { kind: 'prompt', name: 'base' }
      })
    )
    ranges.push({ start: 0, end: baseEnd })
  }

  const nextMainSection = firstPositive(projectContextIdx, skillsPreambleIdx, metadataIdx)
  if (baseEnd >= 0 && nextMainSection > baseEnd) {
    const content = prompt.slice(baseEnd, nextMainSection).trim()
    if (content)
      sections.push(
        entry('custom-system', 'SYSTEM.md / APPEND_SYSTEM.md', 'custom-system-prompt', content, {
          source: { kind: 'prompt', name: 'custom-system' }
        })
      )
    ranges.push({ start: baseEnd, end: nextMainSection })
  }

  if (projectContextIdx >= 0) {
    const start = projectContextIdx + 2
    const end = firstPositive(skillsPreambleIdx, metadataIdx)
    const actualEnd = end >= 0 ? end : prompt.length
    const content = prompt.slice(start, actualEnd)
    sections.push(
      entry('agents', 'AGENTS.md files', 'agents', content, {
        children: parseAgents(content),
        source: { kind: 'prompt', name: 'project-context' }
      })
    )
    ranges.push({ start, end: actualEnd })
  }

  if (skillsPreambleIdx >= 0) {
    const start = skillsPreambleIdx + 2
    const end =
      availableSkillsEnd >= 0
        ? availableSkillsEnd + '</available_skills>'.length
        : metadataIdx >= 0
          ? metadataIdx
          : prompt.length
    const content = prompt.slice(start, end)
    const xml =
      availableSkillsStart >= 0 && availableSkillsEnd >= 0
        ? prompt.slice(availableSkillsStart, availableSkillsEnd + '</available_skills>'.length)
        : ''
    sections.push(
      entry('skills', 'Skills', 'skills', content, {
        children: parseSkills(xml),
        source: { kind: 'prompt', name: 'available-skills' }
      })
    )
    ranges.push({ start, end })
  }

  if (metadataIdx >= 0) {
    const start = metadataIdx + 1
    sections.push(
      entry('metadata', 'Metadata', 'metadata', prompt.slice(start), {
        source: { kind: 'prompt', name: 'metadata' }
      })
    )
    ranges.push({ start, end: prompt.length })
  }

  const toolSection = buildToolSection(pi, gaps)
  if (toolSection) sections.push(toolSection)

  const unknownTexts = uncoveredPromptGaps(prompt, ranges)
  const unknownTokens = unknownTexts.reduce((sum, text) => sum + estimateTokens(text), 0)
  const unknownChars = unknownTexts.reduce((sum, text) => sum + text.length, 0)
  for (const text of unknownTexts) {
    gaps.push({
      label: 'Unattributed prompt segment',
      reason: 'Prompt text did not match known Pi system prompt section markers.',
      tokens: estimateTokens(text),
      chars: text.length
    })
  }
  gaps.push({
    label: 'Extension context attribution',
    reason:
      'Public Pi APIs expose the assembled system prompt, tools, active tools, skills in prompt XML, and context usage, but do not expose every extension contribution as a separate source segment.',
    tokens: 0,
    chars: 0
  })

  const unknown = syntheticEntry('unknown', 'Unknown', 'unknown', unknownTokens, unknownChars, {
    source: { kind: 'unknown' },
    children: unknownTexts.map((text, index) =>
      entry(`unknown:${index}`, `Unattributed segment ${index + 1}`, 'unknown', text, { source: { kind: 'unknown' } })
    )
  })

  const usage = ctx.getContextUsage()
  return {
    generatedAt: new Date().toISOString(),
    totalTokens: estimateTokens(prompt) + (toolSection?.tokens ?? 0),
    totalChars: prompt.length + (toolSection?.chars ?? 0),
    contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
    sections: [...sections, unknown],
    unknown,
    gaps
  }
}
