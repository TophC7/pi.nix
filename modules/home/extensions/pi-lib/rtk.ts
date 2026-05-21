import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentDir, type ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { headBytes } from './subagents/output.ts'

export type RtkMode = 'rewrite' | 'suggest'

export interface RtkConfig {
  readonly enabled: boolean
  readonly mode: RtkMode
}

export interface RtkCommandOptions {
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly maxStdoutBytes?: number
  readonly timeout?: number
}

export interface RtkCommandResult {
  readonly used: boolean
  readonly command: string
  readonly stdout: string
  readonly stderr: string
  readonly code: number
  readonly killed: boolean
  readonly notes: readonly string[]
}

export const RTK_CONFIG_PATH = join(getAgentDir(), 'extensions', 'pi-rtk-optimizer', 'config.json')

const DEFAULT_CONFIG: RtkConfig = {
  enabled: true,
  mode: 'rewrite'
}

let cachedRtkPath: string | undefined | null

export async function runRtkOptimizedCommand(
  pi: ExtensionAPI,
  command: string,
  options: RtkCommandOptions
): Promise<RtkCommandResult> {
  const config = readRtkConfig()
  const notes: string[] = [`RTK config: ${RTK_CONFIG_PATH}`]
  if (!config.enabled) return disabledResult(command, 'RTK optimizer is disabled in config.', notes)
  if (config.mode !== 'rewrite') return disabledResult(command, `RTK optimizer mode is ${config.mode}; rewrite mode required.`, notes)

  const rtk = await resolveRtk(pi, options)
  if (!rtk) return disabledResult(command, 'RTK executable was not found.', notes)
  notes.push(`RTK executable: ${rtk}`)

  const rewritten = await pi.exec(rtk, ['rewrite', command], {
    cwd: options.cwd,
    signal: options.signal,
    timeout: Math.min(options.timeout ?? 3000, 3000)
  })
  const rewrittenCommand = rewritten.stdout.trim()
  if ((rewritten.code !== 0 && rewritten.code !== 3) || !rewrittenCommand || rewrittenCommand === command) {
    const detail = [rewritten.stderr.trim(), rewritten.stdout.trim()].filter(Boolean).join(' ')
    return disabledResult(command, detail || `RTK rewrite did not produce an optimized command (exit ${rewritten.code}).`, notes)
  }
  notes.push(`RTK rewrite: ${command} -> ${rewrittenCommand}`)

  const shellCommand = withRtkEnvironment(withStdoutLimit(rewrittenCommand, options.maxStdoutBytes))
  const result = await pi.exec('sh', ['-lc', shellCommand], {
    cwd: options.cwd,
    signal: options.signal,
    timeout: options.timeout
  })
  const capped = capStdout(result.stdout, options.maxStdoutBytes)
  if (capped.truncated) notes.push(`RTK output truncated at ${options.maxStdoutBytes} bytes.`)
  return {
    used: true,
    command: rewrittenCommand,
    stdout: capped.stdout,
    stderr: result.stderr,
    code: result.code,
    killed: result.killed,
    notes
  }
}

function readRtkConfig(): RtkConfig {
  try {
    const raw = JSON.parse(readFileSync(RTK_CONFIG_PATH, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`Invalid RTK config ${RTK_CONFIG_PATH}: expected object`)
    }
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled,
      mode: raw.mode === 'suggest' ? 'suggest' : DEFAULT_CONFIG.mode
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return DEFAULT_CONFIG
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${RTK_CONFIG_PATH}: ${error.message}`)
    throw error
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

async function resolveRtk(pi: ExtensionAPI, options: RtkCommandOptions): Promise<string | undefined> {
  if (cachedRtkPath !== undefined) return cachedRtkPath ?? undefined
  const result = await pi.exec('which', ['rtk'], { cwd: options.cwd, signal: options.signal, timeout: 1000 })
  cachedRtkPath = result.code === 0 ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null : null
  return cachedRtkPath ?? undefined
}

function disabledResult(command: string, reason: string, notes: readonly string[]): RtkCommandResult {
  return {
    used: false,
    command,
    stdout: '',
    stderr: reason,
    code: 1,
    killed: false,
    notes: [...notes, reason]
  }
}

function withRtkEnvironment(command: string): string {
  return `export RTK_DB_PATH=${quoteForShell(join(tmpdir(), 'pi-rtk-optimizer', 'history.db'))}; ${command}`
}

function withStdoutLimit(command: string, maxBytes: number | undefined): string {
  if (!maxBytes) return command
  return `{ ${command}; } | head -c ${Math.max(1, Math.floor(maxBytes) + 1)}`
}

function capStdout(stdout: string, maxBytes: number | undefined): { readonly stdout: string; readonly truncated: boolean } {
  if (!maxBytes) return { stdout, truncated: false }
  const capped = headBytes(stdout, maxBytes, `[truncated at ${maxBytes} bytes]`)
  return { stdout: capped.text, truncated: Boolean(capped.truncation) }
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
