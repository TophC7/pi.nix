import { SOCKET_ENVIRONMENT_VARIABLE } from './bridge-protocol.js'
import { GATE_ENVIRONMENT_VARIABLE } from './gate.js'

export function agyArguments(options: { model: string; prompt: string; conversation?: string; timeout: string }): string[] {
  const args = [
    '--print',
    options.prompt,
    '--output-format',
    'stream-json',
    '--model',
    options.model,
    '--disable-slash-commands',
    // Safe only because the gate is verified live before every spawn: the
    // PreToolUse hook denies every built-in, so this flag applies to nothing
    // but Pi's own MCP calls. See gate.ts and AGY.md.
    '--dangerously-skip-permissions',
    '--print-timeout',
    options.timeout
  ]
  // Never --continue: its "most recent conversation" state is global and would
  // bleed across Pi sessions.
  if (options.conversation) args.push('--conversation', options.conversation)
  return args
}

export function agyEnvironment(socketPath: string): Record<string, string | undefined> {
  return {
    ...process.env,
    // Scopes the globally-installed gate to Pi's processes. Interactive `agy`
    // never sets this and keeps its full tool set.
    [GATE_ENVIRONMENT_VARIABLE]: '1',
    [SOCKET_ENVIRONMENT_VARIABLE]: socketPath
  }
}
