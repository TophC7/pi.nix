// ## VISUAL ## //
// Agent-authored visual briefs for SDD specs. This module owns only command
// resolution, output-path contract, operation lock, and prompt handoff. The
// agent owns visual judgment and writes the HTML artifact.

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { join, relative, resolve } from 'node:path'
import { deferToAgentEnd } from '@pi/lib/agent-end'
import { getActiveSpec, pickSpec, setActiveSpec } from './active-spec.ts'
import { readSpec, SPEC_ROOT, specExists, specPath, SpecPathError } from './files.ts'
import { startOperation, VISUAL_TOOLS } from './lock.ts'

interface VisualArgs {
  target?: string
  noOpen: boolean
  error?: string
}

export async function runVisual(pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string): Promise<void> {
  await ctx.waitForIdle()
  const parsed = parseVisualArgs(args)
  if (parsed.error) {
    ctx.ui.notify(`/spec:visual: ${parsed.error}\nUsage: /spec:visual [<slug|path>] [--no-open]`, 'error')
    return
  }

  const slug = await resolveVisualSlug(pi, ctx, parsed.target)
  if (!slug) return

  const spec = readSpec(ctx.cwd, slug)
  if (!spec) {
    ctx.ui.notify(`/spec:visual: spec ${slug} not found under ${SPEC_ROOT}.`, 'error')
    return
  }

  const specFile = specPath(ctx.cwd, slug)
  const outputFile = visualArtifactPath(ctx.cwd, slug)
  const relativeOutputFile = join(SPEC_ROOT, 'visuals', `${slug}.html`)
  try {
    startOperation(pi, 'spec:visual', VISUAL_TOOLS, {
      writeRoots: [
        {
          tools: new Set(['write']),
          allowedPrefix: relativeOutputFile,
          reason: `/spec:visual may only write ${relativeOutputFile}. Do not edit specs or source files.`
        },
        {
          tools: new Set(['write']),
          allowedPrefix: outputFile,
          reason: `/spec:visual may only write ${relativeOutputFile}. Do not edit specs or source files.`
        }
      ]
    })
  } catch (error) {
    ctx.ui.notify(`/spec:visual cannot start: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }

  if (!parsed.noOpen) scheduleOpenVisualArtifact(pi, ctx, outputFile)
  pi.sendUserMessage(buildVisualPrompt({ slug, specFile, outputFile, open: !parsed.noOpen }), { deliverAs: 'followUp' })
  ctx.ui.notify(`/spec:visual: handing ${slug} to agent for visual generation.`, 'info')
}

function scheduleOpenVisualArtifact(pi: ExtensionAPI, ctx: ExtensionCommandContext, outputFile: string): void {
  void deferToAgentEnd(pi, async () => {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const result = await pi.exec(opener, [outputFile], {
      cwd: ctx.cwd,
      timeout: 5000
    })
    if (result.code === 0) ctx.ui.notify(`/spec:visual opened ${outputFile}`, 'info')
    else
      ctx.ui.notify(
        `/spec:visual wrote ${outputFile}; open failed: ${result.stderr || `exit ${result.code}`}`,
        'warning'
      )
  })
}

export function visualArtifactPath(cwd: string, slug: string): string {
  return join(cwd, SPEC_ROOT, 'visuals', `${slug}.html`)
}

function parseVisualArgs(args?: string): VisualArgs {
  const parts =
    args
      ?.split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean) ?? []
  let target: string | undefined
  let noOpen = false
  for (const part of parts) {
    if (part === '--no-open') noOpen = true
    else if (part.startsWith('--')) return { target, noOpen, error: `unknown option ${part}` }
    else if (!target) target = part
    else
      return {
        target,
        noOpen,
        error: `multiple targets provided: ${target} and ${part}`
      }
  }
  return { target, noOpen }
}

async function resolveVisualSlug(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  target?: string
): Promise<string | undefined> {
  if (!target) {
    const active = getActiveSpec()
    if (active) {
      if (!specExists(ctx.cwd, active)) {
        ctx.ui.notify(`/spec:visual: active spec ${active} not found under ${SPEC_ROOT}.`, 'error')
        return undefined
      }
      return active
    }
    const picked = await pickSpec(ctx, { allowCreate: false })
    if (picked.kind === 'cancelled') return undefined
    setActiveSpec(pi, ctx, picked.slug)
    return picked.slug
  }

  const slug = target.endsWith('.md') ? slugFromSpecFile(ctx, target) : target
  if (!slug) return undefined
  try {
    specPath(ctx.cwd, slug)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`/spec:visual: ${message}`, 'error')
    return undefined
  }
  if (!specExists(ctx.cwd, slug)) {
    ctx.ui.notify(`/spec:visual: spec ${slug} not found under ${SPEC_ROOT}.`, 'error')
    return undefined
  }
  setActiveSpec(pi, ctx, slug)
  return slug
}

function slugFromSpecFile(ctx: ExtensionCommandContext, input: string): string | undefined {
  const root = resolve(ctx.cwd, SPEC_ROOT)
  const full = resolve(ctx.cwd, input)
  const rel = relative(root, full)
  if (rel.startsWith('..') || rel === '' || rel.includes('..')) {
    ctx.ui.notify(`/spec:visual: spec path must stay under ${SPEC_ROOT}.`, 'error')
    return undefined
  }
  if (!rel.endsWith('.md')) {
    ctx.ui.notify('/spec:visual: spec path must point to a Markdown spec file.', 'error')
    return undefined
  }
  if (rel.includes('/')) {
    ctx.ui.notify(`/spec:visual: spec path must point directly to ${SPEC_ROOT}/<slug>.md.`, 'error')
    return undefined
  }
  const slug = rel.slice(0, -3)
  try {
    specPath(ctx.cwd, slug)
  } catch (error) {
    const message = error instanceof SpecPathError ? error.message : String(error)
    ctx.ui.notify(`/spec:visual: ${message}`, 'error')
    return undefined
  }
  return slug
}

interface VisualPromptInput {
  slug: string
  specFile: string
  outputFile: string
  open: boolean
}

function buildVisualPrompt(input: VisualPromptInput): string {
  const openInstruction = input.open
    ? 'The command will open it after this turn.'
    : 'Opening is disabled by --no-open; report the output path instead.'
  return `Visual brief generation for spec ${input.slug}.

Spec file: ${input.specFile}
Output file: ${input.outputFile}

Run this visual generation now. Stay inside this turn until the HTML file is written. ${openInstruction}

Mission:
Create a custom, self-contained HTML visual brief that helps a technical reader understand the spec faster than reading the Markdown. Do not merely render the Markdown into cards. Choose the visual form that best explains this specific plan.

Hard rules:
- Read the spec first. Treat it as source of truth.
- Do not edit, overwrite, or rewrite the spec Markdown.
- Do not edit source code or any file except the output HTML file above.
- Write one standalone HTML file with inline CSS and any inline JS needed for diagrams/interactions.
- Keep claims grounded in the spec and inspected repo facts. Mark unknowns as unknown.

Visual judgment:
Pick the strongest explanatory structure for this spec. Options include architecture map, before/after comparison, task dependency graph, sequence/state diagram, implementation storyboard, risk heatmap, acceptance/audit matrix, timeline, or focused single-page narrative. Use Mermaid only when topology or flow benefits from it. Use tables when tabular truth matters. Use cards only when they add scanability.

Style guidelines:
- Strong hierarchy: hero, key model, then supporting details.
- Distinct but restrained aesthetic: blueprint, editorial, paper/ink, terminal mono, or named IDE-inspired palette.
- No generic dark dashboard slop, no emoji headers, no glowing cards, no gradient text.
- Use semantic color for status, risk, dependency, verification, and unknown.
- Verified and unverified information must be visually distinct.
- Responsive and print-safe. No horizontal overflow except intentional scrollable tables/diagrams.
- Accessible headings, sections, tables, contrast, and readable code.

Suggested workflow:
1. Read the spec file.
2. Inspect only repo files needed to understand referenced modules, APIs, or architecture.
3. Decide the visual strategy in your own reasoning.
4. Write the finished HTML to the output file.
5. Do not run shell commands or open the file yourself; the command opens the output file after this turn when enabled.
6. End with a brief summary of visual strategy and output path.`
}
