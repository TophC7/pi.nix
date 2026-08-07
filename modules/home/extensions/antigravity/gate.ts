import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import allowedTools from './allowed-tools.json'

export const GATE_ENVIRONMENT_VARIABLE = 'PI_AGY_GATE'

/** Present in gate.sh; proves the installed hook is ours and not an unrelated one. */
export const GATE_MARKER = 'PI_AGY_GATE_V1'

/**
 * The exact case pattern antigravity.nix substitutes into the installed
 * gate.sh, rebuilt here from the same allowed-tools.json. Requiring it in the
 * installed script catches a stale gate whose allowlist has drifted from this
 * extension's expectations.
 */
const GATE_CASE_PATTERN = `${allowedTools.join(' | ')})`

// The ONLY location AGY actually executes hooks from. ~/.gemini/hooks.json and
// ~/.gemini/antigravity-cli/hooks.json are counted by AGY's own
// "loaded N named hooks from N hooks.json file(s)" line and then never fire,
// so that count is not a usable liveness signal on its own.
const HOOKS_PATH = join(homedir(), '.gemini', 'config', 'hooks.json')

type HookEntry = {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string }>
}
type HooksFile = Record<string, { PreToolUse?: HookEntry[] } | undefined>

/**
 * Throws unless the Pi gate is installed where AGY will run it. Revalidated
 * before every spawn, because `--dangerously-skip-permissions` is only
 * defensible while the exact catch-all command gate is still live.
 */
export function assertGateInstalled(): void {
  const error = checkGate()
  if (error) throw error
}

function checkGate(): Error | null {
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

  for (const named of Object.values(parsed)) {
    for (const entry of named?.PreToolUse ?? []) {
      if (entry.matcher !== '*') continue
      for (const hook of entry.hooks ?? []) {
        if (hook.type === 'command' && hook.command && gateScriptIsOurs(hook.command)) return null
      }
    }
  }
  return new Error(`No catch-all Pi command gate found among the PreToolUse hooks in ${HOOKS_PATH}`)
}

function gateScriptIsOurs(command: string): boolean {
  try {
    const script = readFileSync(command, 'utf8')
    return script.includes(GATE_MARKER) && script.includes(GATE_CASE_PATTERN)
  } catch {
    return false
  }
}

// AGY tool names Pi tolerates, from allowed-tools.json — the single source the
// installed gate.sh case pattern is also generated from. Everything else is
// denied by the gate; seeing one complete successfully means the gate did not
// run, so the turn fails.
//
// `call_mcp_tool` is the dispatcher AGY actually uses for Pi tools; the
// per-tool `mcp_pi_*` declarations are shown to the model too, so both forms
// are accepted. `schedule` is a sleep primitive with no filesystem, shell, or
// network effect and is not suppressible by any available means.
const EXACT_NAMES = new Set(allowedTools.filter((name) => !name.endsWith('*')))
const PREFIXES = allowedTools.filter((name) => name.endsWith('*')).map((name) => name.slice(0, -1))

export function isAllowedToolName(name: string): boolean {
  return EXACT_NAMES.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix))
}
