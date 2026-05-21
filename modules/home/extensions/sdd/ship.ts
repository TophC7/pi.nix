// ## SHIP ## //
// Materialize the active spec into Sworm. Command-driven: the agent is not
// involved. Reads the spec, shows ONE confirm overlay, calls the host-side
// applySpec helper, writes back IDs and status. No lock, no handoff.

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { resolveOrPick } from './active-spec.ts'
import { readSpec, SPEC_ROOT, writeSpec } from './files.ts'
import type { Spec } from './parser.ts'
import { applySpec, type ApplyResult } from './sworm-batch.ts'

export async function runShip(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const slug = await resolveOrPick(pi, ctx, args)
  if (!slug) {
    ctx.ui.notify('/spec:ship: no active spec.', 'warning')
    return
  }
  const spec = readSpec(ctx.cwd, slug)
  if (!spec) {
    ctx.ui.notify(`/spec:ship: spec ${slug} not found under ${SPEC_ROOT}.`, 'error')
    return
  }
  if (!spec.goal.trim()) {
    ctx.ui.notify(`/spec:ship refused: ${slug} has no goal. Fill ## Goal before shipping.`, 'warning')
    return
  }
  if (spec.tasks.length === 0) {
    ctx.ui.notify(
      `/spec:ship refused: ${slug} has no canonical tasks. Add ### task blocks with <!-- sworm: slug=... --> and **Acceptance:** before shipping.`,
      'warning'
    )
    return
  }
  const confirmed = await confirmShip(ctx, slug, spec)
  if (!confirmed) {
    ctx.ui.notify(`/spec:ship cancelled for ${slug}.`, 'info')
    return
  }
  try {
    const result = await applySpec(spec)
    persistResultIntoSpec(ctx.cwd, slug, spec, result)
    ctx.ui.notify(formatShipSummary(slug, result), 'info')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`/spec:ship failed: ${message}`, 'error')
  }
}

async function confirmShip(ctx: ExtensionCommandContext, slug: string, spec: Spec): Promise<boolean> {
  if (typeof ctx.ui.select !== 'function') {
    ctx.ui.notify('/spec:ship requires a UI surface with confirm; aborting.', 'error')
    return false
  }
  const summary = renderPlan(spec)
  const choices = [`ship ${spec.tasks.length} tasks`, 'cancel']
  const labelled = `${slug} — ${summary}\n${choices[0]}`
  const choice = await ctx.ui.select(`/spec:ship ${slug}`, [labelled, 'cancel'])
  return choice === labelled
}

function renderPlan(spec: Spec): string {
  const reship = Boolean(spec.frontmatter.epicId)
  const verb = reship ? 're-ship' : 'first ship'
  const depCount = spec.tasks.reduce((sum, task) => sum + task.deps.length, 0)
  const parts = [verb, `${spec.tasks.length} tasks`, `${depCount} dep edges`]
  if (reship) parts.push(`epic ${spec.frontmatter.epicId}`)
  return parts.join(' · ')
}

function persistResultIntoSpec(cwd: string, slug: string, spec: Spec, result: ApplyResult): void {
  const updated: Spec = {
    ...spec,
    frontmatter: {
      ...spec.frontmatter,
      epicId: result.epicId,
      status: 'shipped'
    },
    tasks: spec.tasks.map((task) => ({
      ...task,
      issueId: result.issueIds[task.slug] ?? task.issueId
    }))
  }
  writeSpec(cwd, slug, updated)
}

function formatShipSummary(slug: string, result: ApplyResult): string {
  const parts = [`/spec:ship ${slug} → epic ${result.epicId}`]
  if (result.created.length > 0) parts.push(`created ${result.created.length}`)
  if (result.updated.length > 0) parts.push(`updated ${result.updated.length}`)
  if (result.archived.length > 0) parts.push(`archived ${result.archived.length}`)
  if (result.depEdges > 0) parts.push(`${result.depEdges} dep edges`)
  return parts.join(' · ')
}
