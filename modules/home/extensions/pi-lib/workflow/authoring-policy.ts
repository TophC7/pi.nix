import { isSpecFinalizationActive } from './finalization.ts'
import { SWORM_CONFIG_MUTATION_TOOLS, SWORM_MUTATION_TOOLS } from './profiles.ts'
import type { WorkflowId, WorkflowProfile } from './types.ts'

const SWORM_WRITE_TOOLS = new Set<string>([...SWORM_MUTATION_TOOLS, ...SWORM_CONFIG_MUTATION_TOOLS])

export const ORIGINAL_BASH_COMMAND_KEY = '__piOriginalCommand'

export type AuthoringGuardMode<TMode extends WorkflowId> = 'idle' | TMode

export interface AuthoringToolCallEvent {
  readonly toolName?: string
  readonly input?: unknown
}

export interface AuthoringToolCallBlock {
  readonly block: true
  readonly reason: string
}

export function evaluateAuthoringToolCall<TMode extends WorkflowId>(
  profile: WorkflowProfile | undefined,
  mode: AuthoringGuardMode<TMode>,
  event: AuthoringToolCallEvent
): AuthoringToolCallBlock | undefined {
  if (!profile || mode === 'idle') return
  if (profile.mutation.fileMutationTools === 'block' && (event.toolName === 'write' || event.toolName === 'edit')) {
    return {
      block: true,
      reason: `${event.toolName} blocked during ${mode}; use workflow save tools.`
    }
  }
  if (mode === 'spec-authoring' && SWORM_WRITE_TOOLS.has(event.toolName ?? '') && !isSpecFinalizationActive()) {
    return {
      block: true,
      reason: blockedToolReason(mode, event.toolName ?? 'tool')
    }
  }
  if (profile.mutation.blockedTools.includes(event.toolName ?? '')) {
    return {
      block: true,
      reason: blockedToolReason(mode, event.toolName ?? 'tool')
    }
  }
  if (profile.mutation.mutatingShell !== 'block' || event.toolName !== 'bash') return
  const command = commandForShellPolicy(event.input)
  if (!command) return
  const blocked = profile.mutation.blockedBash.find((rule) => rule.pattern.test(command))
  if (blocked) {
    return {
      block: true,
      reason: `Mutating shell command blocked during ${mode}: ${blocked.reason}.`
    }
  }
}

export function commandForShellPolicy(input: unknown): string | undefined {
  const payload = input as {
    command?: unknown
    [ORIGINAL_BASH_COMMAND_KEY]?: unknown
  }
  if (typeof payload[ORIGINAL_BASH_COMMAND_KEY] === 'string')
    return unwrapFishShellCommand(payload[ORIGINAL_BASH_COMMAND_KEY])
  if (typeof payload.command !== 'string') return undefined
  return unwrapFishShellCommand(payload.command)
}

export function unwrapFishShellCommand(command: string): string {
  const match = command.match(/^\s*(?:\S+\/)?fish\s+-lc\s+(.+?)\s*$/s)
  if (!match) return command
  return unwrapShellWord(match[1])
}

function blockedToolReason<TMode extends WorkflowId>(mode: AuthoringGuardMode<TMode>, toolName: string): string {
  if (mode === 'spec-authoring' && SWORM_WRITE_TOOLS.has(toolName)) {
    return `${toolName} blocked during spec-authoring; Sworm writes require final user approval and approved finalization.`
  }
  return `${toolName} blocked during ${mode}; workflow policy denies this tool.`
}

function unwrapShellWord(value: string): string {
  if (value.length < 2) return value
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("'\\''", "'")
  if (value.startsWith('"') && value.endsWith('"'))
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  return value
}
