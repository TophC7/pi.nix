import type { ExtensionCommandContext, RegisteredCommand } from '@mariozechner/pi-coding-agent'
import type { WorkflowId } from './workflow/index.ts'

export type CommandName = string

export interface DefinedCommand extends Omit<RegisteredCommand, 'name' | 'sourceInfo' | 'handler'> {
  readonly name: CommandName
  readonly workflow?: WorkflowId
  readonly handoff?: unknown
  handler: RegisteredCommand['handler']
}

export interface DefineCommandOptions extends Omit<DefinedCommand, 'handler'> {
  run: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void
}

export function defineCommand(options: DefineCommandOptions): DefinedCommand {
  return {
    name: normalizeCommandName(options.name),
    description: options.description,
    getArgumentCompletions: options.getArgumentCompletions,
    workflow: options.workflow,
    handoff: options.handoff,
    handler: async (args, ctx) => {
      await options.run(args, ctx)
    }
  }
}

export function normalizeCommandName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Command name cannot be empty.')
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
}
