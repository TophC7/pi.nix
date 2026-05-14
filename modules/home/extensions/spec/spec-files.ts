import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { readFrontmatterValue } from './files.ts'
import type { SpecInfo } from './types.ts'

export function listSpecs(): SpecInfo[] {
  const root = '.sworm/spec'
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const specPath = join(root, entry.name)
      const lightIndex = join(specPath, 'SPEC.md')
      const todoIndex = join(specPath, 'todo.md')
      const indexPath = existsSync(lightIndex) ? lightIndex : todoIndex
      if (!existsSync(indexPath)) return undefined
      const files = readdirSync(specPath)
      const shape = existsSync(lightIndex)
        ? 'light'
        : files.some((file) => file.startsWith('ticket-'))
          ? 'ticketed'
          : 'phased'
      const content = readFileSync(indexPath, 'utf8')
      const title = content.match(/^#\s+(.+)$/m)?.[1] ?? entry.name
      const swormEpicId =
        readFrontmatterValue(content, 'sworm_epic_id') || readFrontmatterValue(content, 'epic_id') || undefined
      return {
        name: entry.name,
        path: specPath,
        indexPath,
        shape,
        title,
        swormEpicId
      } satisfies SpecInfo
    })
    .filter((spec): spec is SpecInfo => Boolean(spec))
}

export async function resolveSpec(ctx: ExtensionCommandContext, arg?: string): Promise<SpecInfo | undefined> {
  const specs = listSpecs()
  if (specs.length === 0) {
    ctx.ui.notify('No specs found under .sworm/spec/.', 'error')
    return undefined
  }
  const trimmed = arg?.trim()
  if (trimmed) {
    const match = specs.find((spec) => spec.name === trimmed || spec.path === trimmed || trimmed.includes(spec.path))
    if (match) return match
    ctx.ui.notify(`Spec not found: ${trimmed}`, 'error')
    return undefined
  }
  const cwdSpec = specs.find((spec) => resolve(ctx.cwd).startsWith(resolve(spec.path)))
  if (cwdSpec) return cwdSpec
  if (specs.length === 1) return specs[0]
  const choices = specs.map((spec) => `${spec.title} [${spec.shape}] · ${spec.path}`)
  const choice = await ctx.ui.select('Select active spec:', choices)
  const index = choices.indexOf(choice ?? '')
  return index >= 0 ? specs[index] : undefined
}

export function readSpecFiles(spec: SpecInfo): string {
  const files = readdirSync(spec.path)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return files
    .map((file) => `# FILE ${join(spec.path, file)}\n\n${readFileSync(join(spec.path, file), 'utf8')}`)
    .join('\n\n')
}

export function extractRunChecks(content: string): string[] {
  const checks = new Set<string>()
  for (const match of content.matchAll(/run:\s*`([^`]+)`/g)) {
    if (match[1]) checks.add(match[1].trim())
  }
  for (const match of content.matchAll(/run:\s*([^<\n|]+)/g)) {
    if (match[0]?.includes('`')) continue
    const command = match[1]?.trim()
    if (command) checks.add(command)
  }
  return [...checks]
}

export function extractManualChecks(content: string): string[] {
  return [...content.matchAll(/manual:\s*([^<\n|]+)/g)].map((match) => match[1]?.trim() ?? '').filter(Boolean)
}

export function extractInvariantChecks(content: string): string[] {
  const checks = new Set<string>()
  for (const match of content.matchAll(/Verify:\s*`([^`]+)`/g)) {
    if (match[1]) checks.add(match[1].trim())
  }
  for (const match of content.matchAll(/Verify:\s*([^\n]+)/g)) {
    if (match[0]?.includes('`')) continue
    const command = match[1]?.trim()
    if (command) checks.add(command)
  }
  return [...checks]
}

export function extractIssueIds(content: string): string[] {
  return [...new Set([...content.matchAll(/\bISSUE-\d+\b/g)].map((match) => match[0]))]
}

export function extractEpicIds(content: string): string[] {
  return [...new Set([...content.matchAll(/\bEPIC-\d+\b/g)].map((match) => match[0]))]
}

export function replaceSyncBlock(content: string, block: string): string {
  const start = '<!-- spec-sync:start -->'
  const end = '<!-- spec-sync:end -->'
  const startIndex = content.indexOf(start)
  const endIndex = content.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) throw new Error('Missing spec-sync markers.')
  return `${content.slice(0, startIndex + start.length)}\n${block}\n${content.slice(endIndex)}`
}
