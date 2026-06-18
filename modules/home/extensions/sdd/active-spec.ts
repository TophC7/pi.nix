// ## ACTIVE SPEC ## //
// Session-scoped activeSpec state. Set by /spec [slug] or by any /spec:X with
// an explicit slug arg. Picker fallback when nothing's active. Switching emits
// a toast, republishes the status entry, and posts an in-turn anchor prompt
// so the running conversation immediately knows the spec changed. No
// persistence across sessions: fresh chat starts with no active spec.

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { listSpecs, readSpec, type SpecListing, specPath, writeNewSpec } from './files.ts'
import { setFreehand } from './lock.ts'
import { buildActiveSpecPrompt } from './prompt.ts'
import { clearActiveSpec as clearStatus, publishActiveSpec } from './status.ts'

let activeSlug: string | undefined
let activeCwd: string | undefined

export function getActiveSpec(): string | undefined {
  return activeSlug
}

export function getActiveCwd(): string | undefined {
  return activeCwd
}

export interface SetActiveOptions {
  /** Suppresses the switch-toast for first-time activation. */
  silent?: boolean
}

export function setActiveSpec(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  slug: string,
  options: SetActiveOptions = {}
): void {
  const previous = activeSlug
  const spec = readSpec(ctx.cwd, slug)
  if (!spec) {
    ctx.ui.notify(`Spec ${slug} not found under .sworm/sdd/.`, 'error')
    return
  }
  activeSlug = slug
  activeCwd = ctx.cwd
  // freehand is per-spec-activity. Switching specs (or re-activating the same
  // one) re-arms the draft-mode block.
  setFreehand(false)
  publishActiveSpec({
    slug,
    title: spec.frontmatter.title,
    status: spec.frontmatter.status
  })
  postSpecAnchor(pi, ctx, slug, spec.frontmatter.status)
  if (options.silent) return
  if (previous && previous !== slug) {
    ctx.ui.notify(`Active spec: switched from ${previous} to ${slug}.`, 'info')
  } else if (!previous) {
    ctx.ui.notify(`Active spec: ${slug} (${spec.frontmatter.status}).`, 'info')
  }
}

export function clearActiveSpec(): void {
  activeSlug = undefined
  activeCwd = undefined
  clearStatus()
}

// ABOUT: posts a follow-up message so the running agent turn knows about the
// switch. The `before_agent_start` system-prompt addendum in index.ts only
// fires at turn start, which misses mid-conversation switches. Prompt body
// must not lead with slash-command-shaped text or Pi's command parser will
// hijack the first token.
function postSpecAnchor(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  slug: string,
  status: string
): void {
  if (typeof pi.sendUserMessage !== 'function') return
  const path = specPath(ctx.cwd, slug)
  const anchor = buildActiveSpecPrompt({ slug, path, status, surface: 'followUp' })
  try {
    pi.sendUserMessage(anchor, { deliverAs: 'followUp' })
  } catch {
    // INFO: surfaces don't all support sendUserMessage. Silent skip is fine;
    // the system-prompt addendum still fires on the next agent turn.
  }
}

export interface PickSpecResult {
  kind: 'existing'
  slug: string
}

export type PickResult = PickSpecResult | { kind: 'new'; slug: string } | { kind: 'cancelled' }

/** Returns the active spec slug if set, otherwise prompts via picker. */
export async function resolveOrPick(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  arg?: string
): Promise<string | undefined> {
  const trimmed = arg?.trim()
  if (trimmed) {
    setActiveSpec(pi, ctx, trimmed)
    return getActiveSpec()
  }
  if (activeSlug) return activeSlug
  const picked = await pickSpec(ctx, { allowCreate: false })
  if (picked.kind === 'cancelled') return undefined
  setActiveSpec(pi, ctx, picked.slug)
  return picked.slug
}

export interface PickerOptions {
  allowCreate?: boolean
}

export async function pickSpec(ctx: ExtensionCommandContext, options: PickerOptions = {}): Promise<PickResult> {
  const specs = listSpecs(ctx.cwd)
  if (specs.length === 0 && !options.allowCreate) {
    ctx.ui.notify('No specs under .sworm/sdd/. Run /spec <slug> to create one.', 'warning')
    return { kind: 'cancelled' }
  }
  const labels = specs.map((spec) => describeSpec(spec))
  const newLabel = '+ new spec...'
  const choices = options.allowCreate ? [newLabel, ...labels] : labels
  if (typeof ctx.ui.select !== 'function') {
    ctx.ui.notify('UI picker unavailable in this surface; pass a slug explicitly.', 'warning')
    return { kind: 'cancelled' }
  }
  const choice = await ctx.ui.select('Pick a spec', choices)
  if (!choice) return { kind: 'cancelled' }
  if (choice === newLabel) {
    const newSlug = await promptNewSpec(ctx)
    return newSlug ? { kind: 'new', slug: newSlug } : { kind: 'cancelled' }
  }
  const index = labels.indexOf(choice)
  if (index < 0) return { kind: 'cancelled' }
  return { kind: 'existing', slug: specs[index]!.slug }
}

function describeSpec(spec: SpecListing): string {
  const when = formatWhen(spec.modifiedAt)
  return `${spec.slug} · ${spec.status} · ${when} · ${spec.title}`
}

function formatWhen(date: Date): string {
  const diff = Date.now() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`
  return date.toISOString().slice(0, 10)
}

async function promptNewSpec(ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (typeof ctx.ui.input !== 'function') return undefined
  const slug = (await ctx.ui.input('New spec slug', 'kebab-case, e.g. parse-cli-flag'))?.trim()
  if (!slug) return undefined
  const title = (await ctx.ui.input('Spec title', slug))?.trim() ?? slug
  try {
    writeNewSpec(ctx.cwd, slug, title)
  } catch (error) {
    ctx.ui.notify(`Could not create spec: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return undefined
  }
  return slug
}
