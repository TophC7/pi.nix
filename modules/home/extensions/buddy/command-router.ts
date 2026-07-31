import {
  buddyForget,
  buddyHatch,
  buddyMode,
  buddyMute,
  buddyObserve,
  buddyPet,
  buddyReasoningPurge,
  buddyReasoningStatus,
  buddyRemember,
  buddyRespawn,
  buddyStatus,
  buddyUnmute,
  type BuddyActionResult
} from './actions.ts'
import { refreshBuddyStatus } from './events.ts'

interface ParsedCommand {
  readonly action: string
  readonly options: Record<string, string>
  readonly rest: readonly string[]
}

export function dispatchBuddyCommand(args: string): BuddyActionResult {
  const parsed = parseBuddyCommand(args)
  const result = dispatch(parsed)
  refreshBuddyStatus()
  return result
}

function dispatch(parsed: ParsedCommand): BuddyActionResult {
  switch (parsed.action) {
    case '':
    case 'status':
      return buddyStatus()
    case 'hatch':
      return buddyHatch({
        name: option(parsed, 'name') ?? (parsed.rest.join(' ') || undefined),
        species: option(parsed, 'species'),
        user_id: option(parsed, 'user_id') ?? option(parsed, 'userId')
      })
    case 'remember':
      return buddyRemember({
        content: option(parsed, 'content') ?? parsed.rest.join(' '),
        importance: numberOption(parsed, 'importance')
      })
    case 'respawn':
    case 'release':
      return buddyRespawn()
    case 'observe':
      return buddyObserve({
        summary: option(parsed, 'summary') ?? parsed.rest.join(' '),
        mode: option(parsed, 'mode'),
        cwd: option(parsed, 'cwd')
      })
    case 'pet':
      return buddyPet()
    case 'mute':
      return buddyMute()
    case 'unmute':
      return buddyUnmute()
    case 'mode':
      return buddyMode({
        mode: option(parsed, 'mode') ?? option(parsed, 'voice') ?? parsed.rest[0],
        guard: option(parsed, 'guard') ?? option(parsed, 'reasoning')
      })
    case 'guard':
      return buddyMode({
        guard: option(parsed, 'guard') ?? parsed.rest[0] ?? 'on'
      })
    case 'reasoning':
      return dispatchReasoning(parsed)
    case 'forget':
      return buddyForget({ scope: option(parsed, 'scope') ?? parsed.rest[0] })
    case 'help':
      return buddyHelp()
    default:
      return {
        text: 'Unknown /buddy action "' + parsed.action + '".\n\n' + buddyUsage(),
        isError: true
      }
  }
}

function dispatchReasoning(parsed: ParsedCommand): BuddyActionResult {
  const subcommand = parsed.rest[0] ?? 'status'
  if (subcommand === 'status') return buddyReasoningStatus({ cwd: option(parsed, 'cwd') })
  if (subcommand === 'purge')
    return buddyReasoningPurge({
      scope: option(parsed, 'scope') ?? parsed.rest[1],
      session_id: option(parsed, 'session_id') ?? option(parsed, 'session')
    })
  return {
    text: 'Unknown /buddy reasoning action "' + subcommand + '".\n\n' + buddyUsage(),
    isError: true
  }
}

function parseBuddyCommand(args: string): ParsedCommand {
  const tokens = tokenize(args)
  const [action = '', ...tail] = tokens
  const options: Record<string, string> = {}
  const rest: string[] = []

  for (const token of tail) {
    const separator = token.indexOf('=')
    if (separator > 0) options[token.slice(0, separator)] = token.slice(separator + 1)
    else rest.push(token)
  }

  return { action: action.toLowerCase(), options, rest }
}

function tokenize(args: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(args)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  return tokens
}

function option(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.options[name]
  return value?.trim() || undefined
}

function numberOption(parsed: ParsedCommand, name: string): number | undefined {
  const value = option(parsed, name)
  if (!value) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function buddyHelp(): BuddyActionResult {
  return { text: buddyUsage() }
}

function buddyUsage(): string {
  return [
    'Usage: /buddy <action> [args]',
    '',
    'Actions:',
    '  status',
    '  hatch [name] [species=<species>] [user_id=<id>]',
    '  remember <content> [importance=1-5]',
    '  observe <summary> [mode=backseat|skillcoach|both]',
    '  pet',
    '  mute | unmute',
    '  mode [backseat|skillcoach|both] [guard=on|off]',
    '  guard [on|off]',
    '  reasoning status [cwd=<path>]',
    '  reasoning purge [session|all] [session_id=<id>]',
    '  forget [memories|progress|all]',
    '  respawn'
  ].join('\n')
}
