import { defineCommand } from '@pi/lib'
import type { DefinedCommand } from '@pi/lib/command'
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { dispatchBuddyCommand } from './command-router.ts'
import { openBuddyDialog } from './ui/dialog.ts'
import { publishBuddySpeech } from './ui/speech.ts'

const BUDDY_ACTIONS = [
  { value: 'status', label: 'status', description: 'Show current companion card.' },
  { value: 'hatch', label: 'hatch', description: 'Explicitly hatch a new companion.' },
  { value: 'pet', label: 'pet', description: 'Pet Buddy and award small XP.' },
  { value: 'mode', label: 'mode', description: 'Set voice mode: backseat, skillcoach, both.' },
  { value: 'guard', label: 'guard', description: 'Toggle guard-mode reasoning observations.' },
  { value: 'remember', label: 'remember', description: 'Store a Buddy memory.' },
  { value: 'forget', label: 'forget', description: 'Forget memories, progress, or all state.' },
  { value: 'reasoning', label: 'reasoning', description: 'Show or purge guard-mode reasoning state.' },
  { value: 'mute', label: 'mute', description: 'Quiet Buddy reactions.' },
  { value: 'unmute', label: 'unmute', description: 'Restore Buddy reactions.' },
  { value: 'respawn', label: 'respawn', description: 'Release current companion.' }
] as const

export const buddyCommands: readonly DefinedCommand[] = [
  defineCommand({
    name: 'buddy',
    description: 'Open the local Pi Buddy dialog, or run /buddy <action>.',
    getArgumentCompletions: completeBuddyArguments,
    run: async (args, ctx) => runBuddyCommand(ctx, args)
  })
]

async function runBuddyCommand(ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle()
  const action = firstAction(args)

  if (action === '' || action === 'settings' || action === 'config' || action === 'help') {
    const result = openBuddyDialog(ctx)
    if (result.isError) ctx.ui.notify(result.text, 'warning')
    return
  }

  const result = dispatchBuddyCommand(args)
  if (result.isError) {
    ctx.ui.notify(summarizeCommandResult(action, result.text, result.details), 'warning')
    return
  }
  if (action === 'pet') return
  if (action === 'observe') {
    publishBuddySpeech(result)
    return
  }
  ctx.ui.notify(summarizeCommandResult(action, result.text, result.details), 'info')
}

function completeBuddyArguments(argumentPrefix: string) {
  const prefix = argumentPrefix.trimStart()
  const action = firstAction(prefix)
  if (!prefix.includes(' ')) return filterCompletions(BUDDY_ACTIONS, prefix)

  if (action === 'mode') {
    return filterCompletions([
      { value: 'backseat', label: 'backseat', description: 'Small nudges and reactions.' },
      { value: 'skillcoach', label: 'skillcoach', description: 'More explicit coaching voice.' },
      { value: 'both', label: 'both', description: 'Backseat reactions plus coaching.' },
      { value: 'guard=on', label: 'guard=on', description: 'Enable reasoning graph guard.' },
      { value: 'guard=off', label: 'guard=off', description: 'Disable reasoning graph guard.' }
    ], lastToken(prefix))
  }

  if (action === 'guard') {
    return filterCompletions([
      { value: 'on', label: 'on', description: 'Enable guard mode.' },
      { value: 'off', label: 'off', description: 'Disable guard mode.' }
    ], lastToken(prefix))
  }

  if (action === 'forget') {
    return filterCompletions([
      { value: 'memories', label: 'memories', description: 'Forget stored memories only.' },
      { value: 'progress', label: 'progress', description: 'Reset XP/progress only.' },
      { value: 'all', label: 'all', description: 'Forget all Buddy data.' }
    ], lastToken(prefix))
  }

  if (action === 'reasoning') {
    return filterCompletions([
      { value: 'status', label: 'status', description: 'Show current guard graph counts.' },
      { value: 'purge', label: 'purge', description: 'Purge reasoning session/all graph state.' }
    ], lastToken(prefix))
  }

  return null
}

function filterCompletions<T extends { readonly value: string }>(items: readonly T[], prefix: string): T[] {
  const needle = prefix.toLowerCase()
  return items.filter((item) => item.value.toLowerCase().startsWith(needle))
}

function firstAction(args: string): string {
  return args.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
}

function lastToken(args: string): string {
  return args.trim().split(/\s+/).at(-1) ?? ''
}

function summarizeCommandResult(action: string, text: string, details: unknown): string {
  const resultDetails = details as { companion?: { name?: string; species?: string }; animation?: string } | undefined
  const companion = resultDetails?.companion
  if (action === 'hatch' && companion?.name && companion.species) {
    const animation = resultDetails?.animation ?? text
    return animation.length <= 700 ? animation : `Hatched ${companion.name} the ${companion.species}. Run /buddy for the full Buddy view.`
  }
  if (text.length <= 700) return text
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)
  return firstLine ? `${firstLine}\nRun /buddy for the full Buddy view.` : 'Buddy updated. Run /buddy for details.'
}
