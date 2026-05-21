// ## COMMANDS ## //
// Registers /spec, /spec:check, /spec:ship, /spec:work, /spec:visual,
// /spec:close, /spec:freehand. Handlers are thin; real work lives in the sibling modules.

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { clearActiveSpec, getActiveSpec, pickSpec, setActiveSpec } from './active-spec.ts'
import { runCheck } from './check.ts'
import { specExists } from './files.ts'
import { closeAll, getFreehand, setFreehand } from './lock.ts'
import { runShip } from './ship.ts'
import { runVisual } from './visual.ts'
import { runWork } from './work.ts'

export function registerSddCommands(pi: ExtensionAPI): void {
  pi.registerCommand('spec', {
    description: 'Open or pick a spec under .sworm/sdd/. Pass <slug> to jump.',
    handler: async (args, ctx) => runOpen(pi, ctx, args)
  })

  pi.registerCommand('spec:check', {
    description: 'Verify the active spec against the repo. Scout-driven; asks user on real ambiguities.',
    handler: async (args, ctx) => runCheck(pi, ctx, args)
  })

  pi.registerCommand('spec:ship', {
    description: 'Materialize the active spec into Sworm (epic + issues + deps). One confirm.',
    handler: async (args, ctx) => runShip(pi, ctx, args)
  })

  pi.registerCommand('spec:work', {
    description: 'Run the autonomous work loop on the active spec until done or blocked.',
    handler: async (args, ctx) => runWork(pi, ctx, args)
  })

  pi.registerCommand('spec:visual', {
    description: 'Hand the active spec or explicit <slug|path> to the agent to create and open a visual HTML brief.',
    handler: async (args, ctx) => runVisual(pi, ctx, args)
  })

  pi.registerCommand('spec:close', {
    description: 'Reset sdd state: clear active spec, clear any in-flight operation, clear freehand.',
    handler: async (_args, ctx) => runClose(ctx)
  })

  pi.registerCommand('spec:freehand', {
    description: 'Toggle the draft-mode write block. Auto-resets on next /spec activity.',
    handler: async (_args, ctx) => runFreehand(ctx)
  })
}

async function runOpen(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const slug = args?.trim()
  if (slug) {
    if (!specExists(ctx.cwd, slug)) {
      ctx.ui.notify(`Spec ${slug} does not exist. Pick "+ new spec..." from /spec to create.`, 'warning')
      return
    }
    setActiveSpec(pi, ctx, slug)
    return
  }
  const picked = await pickSpec(ctx, { allowCreate: true })
  if (picked.kind === 'cancelled') return
  setActiveSpec(pi, ctx, picked.slug, { silent: picked.kind === 'new' })
  if (picked.kind === 'new') {
    ctx.ui.notify(`Created spec ${picked.slug}. Start the conversation; the agent will help shape it.`, 'info')
  }
}

async function runClose(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle()
  const previous = getActiveSpec()
  clearActiveSpec()
  closeAll()
  ctx.ui.notify(
    previous
      ? `sdd state reset; spec ${previous} no longer active.`
      : `sdd state reset; no active operation, no freehand.`,
    'info'
  )
}

async function runFreehand(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle()
  const slug = getActiveSpec()
  if (!slug) {
    ctx.ui.notify('No active spec; freehand has no effect. Run /spec <slug> first.', 'warning')
    return
  }
  const next = !getFreehand()
  setFreehand(next)
  ctx.ui.notify(
    next
      ? `Freehand on: writes outside .sworm/sdd/ permitted for spec ${slug} until next /spec activity.`
      : `Freehand off: draft-mode block re-armed for spec ${slug}.`,
    'info'
  )
}
