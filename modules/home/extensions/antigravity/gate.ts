import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import allowedTools from './allowed-tools.json'
import hostPolicy from './host-policy.json'

export const GATE_ENVIRONMENT_VARIABLE = 'PI_AGY_GATE'

/** Present in installed hook scripts; prove they are ours rather than unrelated commands. */
export const GATE_MARKER = 'PI_AGY_GATE_V1'
export const PROMPT_HOOK_MARKER = 'PI_AGY_PROMPT_V1'

/**
 * Exact policy patterns antigravity.nix substitutes into gate.sh. Requiring
 * them catches an installed gate whose allowlist or Pi server has drifted.
 */
const GATE_CASE_PATTERN = `${allowedTools.join(' | ')})`
const GATE_SERVER_PATTERN = `${hostPolicy.serverName}|'"${hostPolicy.serverName}"')`

// The ONLY location AGY actually executes hooks from. ~/.gemini/hooks.json and
// ~/.gemini/antigravity-cli/hooks.json are counted by AGY's own
// "loaded N named hooks from N hooks.json file(s)" line and then never fire,
// so that count is not a usable liveness signal on its own.
const HOOKS_PATH = join(homedir(), '.gemini', 'config', 'hooks.json')
const SETTINGS_PATH = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
const REQUIRED_PERMISSION = `mcp(${hostPolicy.serverName}/*)`

type HookCommand = { type?: string; command?: string }
type HookEntry = {
  matcher?: string
  hooks?: HookCommand[]
}
type HooksFile = Record<
  string,
  { PreInvocation?: HookCommand[]; PreToolUse?: HookEntry[] } | undefined
>

/**
 * Throws unless Pi's hooks and scoped MCP permission are installed. Checked
 * before every spawn: the gate and permission are safety boundaries, while a
 * missing PreInvocation hook would silently lose Pi's system prompt.
 */
export function assertHostConfiguration(): void {
  const error = checkHooks() ?? checkPermission()
  if (error) throw error
}

function checkHooks(): Error | null {
  let raw: string
  try {
    raw = readFileSync(HOOKS_PATH, 'utf8')
  } catch {
    return new Error(
      `Antigravity tool gate is not installed at ${HOOKS_PATH}. ` +
        'Enable programs.pi.antigravity in your Nix configuration and rebuild.'
    )
  }

  let parsed: HooksFile
  try {
    parsed = JSON.parse(raw) as HooksFile
  } catch {
    return new Error(`Antigravity tool gate config at ${HOOKS_PATH} is not valid JSON`)
  }

  let gateFound = false
  let promptHookFound = false
  for (const named of Object.values(parsed)) {
    promptHookFound ||= (named?.PreInvocation ?? []).some(
      (hook) =>
        hook.type === 'command' &&
        typeof hook.command === 'string' &&
        scriptHasMarkers(hook.command, [PROMPT_HOOK_MARKER])
    )
    gateFound ||= (named?.PreToolUse ?? []).some(
      (entry) =>
        entry.matcher === '*' &&
        (entry.hooks ?? []).some(
          (hook) =>
            hook.type === 'command' &&
            typeof hook.command === 'string' &&
            scriptHasMarkers(hook.command, [GATE_MARKER, GATE_CASE_PATTERN, GATE_SERVER_PATTERN])
        )
    )
    if (gateFound && promptHookFound) break
  }
  if (!gateFound) return new Error(`No catch-all Pi command gate found among the PreToolUse hooks in ${HOOKS_PATH}`)
  if (!promptHookFound) return new Error(`No Pi system-prompt hook found among the PreInvocation hooks in ${HOOKS_PATH}`)
  return null
}

function checkPermission(): Error | null {
  let settings: { permissions?: { allow?: unknown } }
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as typeof settings
  } catch {
    return new Error(`Antigravity settings at ${SETTINGS_PATH} are missing or invalid; rebuild the Home Manager configuration`)
  }
  const allow = settings.permissions?.allow
  if (!Array.isArray(allow) || !allow.includes(REQUIRED_PERMISSION)) {
    return new Error(`Antigravity permission ${REQUIRED_PERMISSION} is not installed; rebuild the Home Manager configuration`)
  }
  return null
}

function scriptHasMarkers(command: string, markers: string[]): boolean {
  try {
    const script = readFileSync(command, 'utf8')
    return markers.every((marker) => script.includes(marker))
  } catch {
    return false
  }
}

// AGY tool names Pi tolerates, from allowed-tools.json — the single source the
// installed gate.sh case pattern is also generated from. Everything else is
// denied by the gate; seeing one complete successfully means the gate did not
// run, so the turn fails.
//
// `call_mcp_tool` is the generic dispatcher AGY uses for MCP tools. Both the
// shell gate and completed-tool guard accept it only when its arguments select
// the `pi` server. Direct `mcp_pi_*` declarations are Pi-scoped by name.
// `schedule` is an inert sleep primitive and cannot be hidden.
const EXACT_NAMES = new Set(allowedTools.filter((name) => !name.endsWith('*')))
const PREFIXES = allowedTools.filter((name) => name.endsWith('*')).map((name) => name.slice(0, -1))

export function isAllowedToolName(name: string): boolean {
  return EXACT_NAMES.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Fail closed if a tool completed despite falling outside Pi's gate policy. */
export function assertCompletedToolAllowed(step: Record<string, any>, state: string): void {
  const name = String(step.tool_name ?? step.tool_info?.name ?? '')
  if (!name || state !== 'DONE' || step.tool_info?.error) return
  if (name === 'call_mcp_tool' && mcpServerName(step.tool_info?.parameters) !== hostPolicy.serverName) {
    throw new Error('agy executed call_mcp_tool against a non-Pi server; refusing to continue')
  }
  if (isAllowedToolName(name)) return
  throw new Error(
    `agy executed the built-in tool "${name}" outside Pi. The PreToolUse gate is not active; ` +
      'refusing to continue.'
  )
}

function mcpServerName(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return ''
  const values = parameters as Record<string, unknown>
  const server = values.ServerName ?? values.serverName ?? values.server_name
  return typeof server === 'string' ? server.replace(/^"|"$/g, '') : ''
}
