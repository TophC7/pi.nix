import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface RuntimeProfile {
  readonly model?: string
  readonly thinking?: ThinkingLevel
}

export interface MainRuntimeRestoreState {
  readonly label: string
  readonly model: Model<Api> | undefined
  readonly thinking: ThinkingLevel
}

export interface RuntimeProfileTaskFields {
  readonly model?: string
  readonly thinking?: ThinkingLevel
}

export class RuntimeProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeProfileError'
  }
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

export function hasRuntimeProfileSettings(profile: RuntimeProfile | undefined): boolean {
  return Boolean(profile?.model || profile?.thinking)
}

export function readRuntimeProfileConfig(value: unknown, source: string): RuntimeProfile {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeProfileError(
      `Invalid runtime profile in ${source}: expected an object with optional model/thinking.`
    )
  }

  const candidate = value as {
    readonly model?: unknown
    readonly thinking?: unknown
  }
  return {
    model: readModelSpec(candidate.model, source),
    thinking: readThinkingLevel(candidate.thinking, source)
  }
}

export function normalizeModelSpec(value: string, source: string): string {
  const spec = value.trim()
  const slash = spec.indexOf('/')
  if (slash <= 0 || slash === spec.length - 1) {
    throw new RuntimeProfileError(
      `Invalid runtime profile model in ${source}: ${JSON.stringify(value)}. Use provider/model-id.`
    )
  }
  return spec
}

export function resolveRuntimeProfileModel(ctx: ExtensionContext, modelSpec: string, source: string): Model<Api> {
  const spec = normalizeModelSpec(modelSpec, source)
  const slash = spec.indexOf('/')
  const provider = spec.slice(0, slash)
  const modelId = spec.slice(slash + 1)
  const model = ctx.modelRegistry.find(provider, modelId)
  if (!model) {
    throw new RuntimeProfileError(`Model not found for runtime profile in ${source}: ${spec}. Check provider/model-id.`)
  }
  return model as Model<Api>
}

export function captureMainRuntimeProfile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  label: string
): MainRuntimeRestoreState {
  return {
    label,
    model: ctx.model,
    thinking: pi.getThinkingLevel() as ThinkingLevel
  }
}

export async function applyMainRuntimeProfile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  profile: RuntimeProfile,
  options: { readonly source: string }
): Promise<void> {
  if (profile.model) {
    const model = resolveRuntimeProfileModel(ctx, profile.model, options.source)
    const ok = await pi.setModel(model)
    if (!ok)
      throw new RuntimeProfileError(
        `No API key for runtime profile model in ${options.source}: ${model.provider}/${model.id}.`
      )
  }

  if (profile.thinking) pi.setThinkingLevel(profile.thinking)
}

export async function restoreMainRuntimeProfile(
  pi: ExtensionAPI,
  restore: MainRuntimeRestoreState | undefined
): Promise<void> {
  if (!restore) return
  if (restore.model) await pi.setModel(restore.model)
  pi.setThinkingLevel(restore.thinking)
}

export function runtimeProfileTaskFields(profile: RuntimeProfile): RuntimeProfileTaskFields {
  if (profile.model) normalizeModelSpec(profile.model, 'subagent runtime profile')
  return {
    model: profile.model,
    thinking: profile.thinking
  }
}

export function formatRuntimeProfileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readModelSpec(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw new RuntimeProfileError(`Invalid runtime profile model in ${source}: expected provider/model-id string.`)
  }
  const trimmed = value.trim()
  return trimmed ? normalizeModelSpec(trimmed, source) : undefined
}

function readThinkingLevel(value: unknown, source: string): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (isThinkingLevel(value)) return value
  throw new RuntimeProfileError(
    `Invalid runtime profile thinking in ${source}: ${JSON.stringify(value)}. Expected one of: ${THINKING_LEVELS.join(', ')}.`
  )
}
