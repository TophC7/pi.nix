import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import {
  parseSystemPromptMode,
  parseThinking,
  type SubagentSystemPromptMode,
  type SubagentThinkingLevel
} from './request.ts'

export type AgentScope = 'user' | 'project' | 'both'
export type AgentSource = 'package' | 'user' | 'project'
export type AgentToolPolicy = 'all' | 'builtins' | 'none' | string[]

export interface DiscoveredAgent {
  name: string
  runtimeName: string
  package?: string
  description?: string
  filePath: string
  source: AgentSource
  systemPrompt: string
  model?: string
  thinking?: SubagentThinkingLevel
  rawThinking?: string
  tools?: AgentToolPolicy
  systemPromptMode?: SubagentSystemPromptMode
  rawSystemPromptMode?: string
  inheritProjectContext?: boolean
  inheritSkills?: boolean
  defaultContext?: 'fresh' | 'fork'
  skills?: string[]
  extensions?: string[]
}

export interface DiscoverAgentsOptions {
  cwd: string
  agentDir?: string
  agentScope?: AgentScope
  userAgentsDir?: string
  projectAgentsDir?: string
  packageAgentsDir?: string
  localPackagesDir?: string
}

interface ParsedAgentFile {
  frontmatter: Record<string, string>
  systemPrompt: string
}

interface AgentRoot {
  dir: string
  source: AgentSource
  packageRoot?: boolean
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function discoverAgents(options: DiscoverAgentsOptions): DiscoveredAgent[] {
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const scope = options.agentScope ?? 'both'
  const roots = buildAgentRoots(options, agentDir, scope)
  return mergeAgentsByPrecedence(roots.flatMap((root) => readAgentRoot(root)))
}

export function mergeAgentsByPrecedence(agents: readonly DiscoveredAgent[]): DiscoveredAgent[] {
  // Precedence for agentScope "both": package < user < project.
  // Later roots intentionally replace earlier runtime names.
  const byName = new Map<string, DiscoveredAgent>()
  for (const agent of agents) byName.set(agent.runtimeName, agent)
  return [...byName.values()].sort((a, b) => a.runtimeName.localeCompare(b.runtimeName))
}

function buildAgentRoots(options: DiscoverAgentsOptions, agentDir: string, scope: AgentScope): AgentRoot[] {
  const roots: AgentRoot[] = []
  const seenRootDirs = new Set<string>()
  const addRoot = (root: AgentRoot) => {
    if (seenRootDirs.has(root.dir)) return
    seenRootDirs.add(root.dir)
    roots.push(root)
  }
  const sharedAgentsDir = options.packageAgentsDir ?? join(agentDir, 'agents')
  addRoot({ dir: sharedAgentsDir, source: 'package', packageRoot: true })
  if (options.localPackagesDir) {
    for (const pkg of safeReadDir(options.localPackagesDir)) {
      const agentsDir = join(options.localPackagesDir, pkg, 'agents')
      if (safeIsDirectory(agentsDir)) addRoot({ dir: agentsDir, source: 'package' })
    }
  }
  if ((scope === 'user' || scope === 'both') && options.userAgentsDir) {
    addRoot({ dir: options.userAgentsDir, source: 'user' })
  }
  if (scope === 'project' || scope === 'both') {
    addRoot({
      dir: options.projectAgentsDir ?? join(options.cwd, '.pi', 'agents'),
      source: 'project'
    })
  }
  return roots
}

function readAgentRoot(root: AgentRoot): DiscoveredAgent[] {
  if (!safeIsDirectory(root.dir)) return []
  return listMarkdownFiles(root.dir).flatMap((filePath) => {
    const parsed = parseAgentFile(readFileSync(filePath, 'utf8'))
    if (!parsed) return []
    const name = parsed.frontmatter.name ?? basename(filePath, '.md')
    const packageName = parsed.frontmatter.package
    const runtimeName = packageName ? `${packageName}.${name}` : name
    const rawThinking = parsed.frontmatter.thinking
    const rawSystemPromptMode = parsed.frontmatter.systemPromptMode
    const thinking = parseThinking(rawThinking)
    const systemPromptMode = parseSystemPromptMode(rawSystemPromptMode)
    // Invalid optional frontmatter is ignored; discovery must not write to stderr.
    return [
      {
        name,
        runtimeName,
        package: packageName,
        description: parsed.frontmatter.description,
        filePath,
        source: inferSource(root, filePath, packageName),
        systemPrompt: parsed.systemPrompt,
        model: parsed.frontmatter.model,
        thinking,
        rawThinking,
        tools: parseTools(parsed.frontmatter.tools),
        systemPromptMode,
        rawSystemPromptMode,
        inheritProjectContext: parseBoolean(parsed.frontmatter.inheritProjectContext),
        inheritSkills: parseBoolean(parsed.frontmatter.inheritSkills),
        defaultContext: parseDefaultContext(parsed.frontmatter.defaultContext),
        skills: parseList(parsed.frontmatter.skills),
        extensions: parseList(parsed.frontmatter.extensions)
      }
    ]
  })
}

function inferSource(root: AgentRoot, filePath: string, packageName: string | undefined): AgentSource {
  if (!root.packageRoot) return root.source
  const [firstSegment] = relative(root.dir, filePath).split(/[\\/]/)
  if (packageName && firstSegment === packageName) return 'package'
  return root.source === 'package' ? 'user' : root.source
}

export function parseAgentFile(content: string): ParsedAgentFile | undefined {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return undefined
  const metadata = match[1] ?? ''
  return {
    frontmatter: parseFrontmatter(metadata),
    systemPrompt: content.slice(match[0].length).trim()
  }
}

function parseFrontmatter(metadata: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of metadata.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key) values[key] = stripQuotes(value.replace(/\s+#.*$/, '').trim())
  }
  return values
}

function parseTools(value: string | undefined): AgentToolPolicy | undefined {
  if (!value) return undefined
  if (value === 'all' || value === 'builtins' || value === 'none') return value
  return parseList(value) ?? []
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (['true', 'yes', '1'].includes(value)) return true
  if (['false', 'no', '0'].includes(value)) return false
  return undefined
}

function parseDefaultContext(value: string | undefined): 'fresh' | 'fork' | undefined {
  return value === 'fresh' || value === 'fork' ? value : undefined
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function listMarkdownFiles(dir: string): string[] {
  const entries = safeReadDir(dir)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    if (safeIsDirectory(path)) {
      files.push(...listMarkdownFiles(path))
    } else if (entry.endsWith('.md')) {
      files.push(path)
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}
