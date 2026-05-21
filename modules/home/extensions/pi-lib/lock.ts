import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { deferToAgentEnd } from './agent-end.ts'

export interface ActiveOperation {
  readonly name: string
  readonly allowed: Set<string>
  readonly pathBlocks?: readonly PathBlock[]
  readonly writeRoots?: readonly WriteRoot[]
}

export interface PathBlock {
  /** Tool names this rule guards. Usually `write` and/or `edit`. */
  readonly tools: ReadonlySet<string>
  /** Directory prefix that, when matched, rejects the tool call. */
  readonly forbiddenPrefix: string
  /** Human-readable reason for the rejection. */
  readonly reason: string
}

export interface WriteRoot {
  /** Tool names this rule guards. Usually `write` and/or `edit`. */
  readonly tools: ReadonlySet<string>
  /** Path or directory prefix that the tool path must stay under. */
  readonly allowedPrefix: string
  /** Human-readable reason for the rejection. */
  readonly reason: string
}

export interface OperationOptions {
  /** Optional write-path blocks layered on top of the allow-set. */
  readonly pathBlocks?: readonly PathBlock[]
  /** Optional write roots; guarded tool paths must stay under one of these roots. */
  readonly writeRoots?: readonly WriteRoot[]
}

export interface ToolCallBlock {
  readonly block: true
  readonly reason: string
}

let activeOperation: ActiveOperation | undefined
const lockInterceptorInstalled = new WeakSet<ExtensionAPI>()

export function startOperation(
  pi: ExtensionAPI,
  name: string,
  allowedTools: readonly string[],
  options: OperationOptions = {}
): void {
  if (activeOperation) {
    throw new Error(`Cannot start ${name}: ${activeOperation.name} is already active.`)
  }
  activeOperation = {
    name,
    allowed: new Set(allowedTools),
    pathBlocks: options.pathBlocks,
    writeRoots: options.writeRoots
  }
  // INFO: deferToAgentEnd drains all pending callbacks on the next agent_end.
  // One agent turn equals one operation lifetime.
  deferToAgentEnd(pi, () => {
    activeOperation = undefined
  })
}

export function closeAll(): void {
  activeOperation = undefined
}

export function getActiveOperation(): { name: string } | undefined {
  return activeOperation ? { name: activeOperation.name } : undefined
}

export function getOperationAllowed(): readonly string[] | undefined {
  return activeOperation ? [...activeOperation.allowed] : undefined
}

export function installLockInterceptor(pi: ExtensionAPI): void {
  if (lockInterceptorInstalled.has(pi)) return
  lockInterceptorInstalled.add(pi)
  pi.on('tool_call', (event): ToolCallBlock | undefined => {
    const toolName = event.toolName ?? ''
    if (!activeOperation) return undefined
    if (!activeOperation.allowed.has(toolName)) {
      return {
        block: true,
        reason: `${toolName} is not allowed during ${activeOperation.name}.`
      }
    }
    const rootBlocked = matchOperationWriteRoot(activeOperation, toolName, event.input)
    if (rootBlocked) return { block: true, reason: rootBlocked }
    const blocked = matchOperationPathBlock(activeOperation, toolName, event.input)
    if (blocked) return { block: true, reason: blocked }
    return undefined
  })
}

function matchOperationWriteRoot(op: ActiveOperation, toolName: string, input: unknown): string | undefined {
  if (!op.writeRoots) return undefined
  const path = extractPath(input)
  if (!path) return undefined
  const applicable = op.writeRoots.filter((rule) => rule.tools.has(toolName))
  if (applicable.length === 0) return undefined
  for (const rule of applicable) {
    const prefix = stripTrailingSlash(rule.allowedPrefix)
    if (!prefix) continue
    if (isInsideDir(path, prefix)) return undefined
  }
  return applicable[0]?.reason
}

function matchOperationPathBlock(op: ActiveOperation, toolName: string, input: unknown): string | undefined {
  if (!op.pathBlocks) return undefined
  const path = extractPath(input)
  if (!path) return undefined
  for (const rule of op.pathBlocks) {
    if (!rule.tools.has(toolName)) continue
    const prefix = stripTrailingSlash(rule.forbiddenPrefix)
    if (!prefix) continue
    if (isInsideDir(path, prefix)) return rule.reason
  }
  return undefined
}

// ABOUT: handles relative ('.sworm/sdd/foo.md'), dot-prefixed
// ('./.sworm/sdd/foo.md'), and absolute ('/repo/.../.sworm/sdd/foo.md') paths.
// Pi tools pass any of these depending on caller.
export function isInsideDir(path: string, dir: string): boolean {
  if (!dir) return false
  const norm = path.replace(/^\.\//, '')
  const target = stripTrailingSlash(dir.replace(/^\.\//, ''))
  return norm === target || norm.startsWith(target + '/') || norm.includes('/' + target + '/')
}

export function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

export function extractPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const candidate = (input as { path?: unknown }).path
  return typeof candidate === 'string' ? candidate : undefined
}
