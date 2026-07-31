import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { RuntimeProfile, ThinkingLevel } from './runtime-profile.ts'

export type ConfigRowKind = 'model' | 'thinking' | 'text'

type ConfigRowSource = string | ((ctx: ExtensionCommandContext) => string)

interface ConfigRowBase {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly detail?: string
  readonly source?: ConfigRowSource
}

export interface ModelConfigRow extends ConfigRowBase {
  readonly kind: 'model'
  readonly get: (ctx: ExtensionCommandContext) => string | undefined
  readonly set: (model: string | undefined, ctx: ExtensionCommandContext) => void
}

export interface ThinkingConfigRow extends ConfigRowBase {
  readonly kind: 'thinking'
  readonly get: (ctx: ExtensionCommandContext) => ThinkingLevel | undefined
  readonly set: (thinking: ThinkingLevel | undefined, ctx: ExtensionCommandContext) => void
}

export interface TextConfigRow extends ConfigRowBase {
  readonly kind: 'text'
  readonly fieldLabel?: string
  readonly placeholder?: string
  readonly unsetLabel?: string
  readonly get: (ctx: ExtensionCommandContext) => string | undefined
  readonly set: (value: string | undefined, ctx: ExtensionCommandContext) => void
  readonly validate?: (value: string) => string | undefined
}

export type ConfigRegistryRow = ModelConfigRow | ThinkingConfigRow | TextConfigRow

export interface ConfigRegistrySection {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly rows: readonly ConfigRegistryRow[] | ((ctx: ExtensionCommandContext) => readonly ConfigRegistryRow[])
  readonly status?: (ctx: ExtensionCommandContext) => string
}

export interface RuntimeProfileConfigSectionInput {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly profiles: readonly RuntimeProfileConfigEntry[]
  readonly status?: (ctx: ExtensionCommandContext) => string
}

export interface RuntimeProfileConfigEntry {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly source?: ConfigRowSource
  readonly get: (ctx: ExtensionCommandContext) => RuntimeProfile
  readonly set: (profile: RuntimeProfile, ctx: ExtensionCommandContext) => void
}

const CONFIG_REGISTRY_GLOBAL_KEY = '__piConfigRegistrySections_v1'

type ConfigRegistryGlobal = typeof globalThis & {
  [CONFIG_REGISTRY_GLOBAL_KEY]?: Map<string, ConfigRegistrySection>
}

function configSections(): Map<string, ConfigRegistrySection> {
  const host = globalThis as ConfigRegistryGlobal
  host[CONFIG_REGISTRY_GLOBAL_KEY] ??= new Map<string, ConfigRegistrySection>()
  return host[CONFIG_REGISTRY_GLOBAL_KEY]
}

export function registerConfigSection(section: ConfigRegistrySection): void {
  configSections().set(section.id, section)
}

export function registerRuntimeProfileConfigSection(input: RuntimeProfileConfigSectionInput): void {
  registerConfigSection({
    id: input.id,
    title: input.title,
    description: input.description,
    status: input.status,
    rows: (ctx) =>
      input.profiles.flatMap((profile) => [
        {
          kind: 'model' as const,
          id: `${profile.id}.model`,
          label: profile.label,
          description: profile.description,
          source: profile.source,
          get: (ctx) => profile.get(ctx).model,
          set: (model: string | undefined, ctx) => profile.set({ ...profile.get(ctx), model }, ctx)
        },
        {
          kind: 'thinking' as const,
          id: `${profile.id}.thinking`,
          label: profile.label,
          description: profile.description,
          source: profile.source,
          get: (ctx) => profile.get(ctx).thinking,
          set: (thinking: ThinkingLevel | undefined, ctx) => profile.set({ ...profile.get(ctx), thinking }, ctx)
        }
      ])
  })
}

export function getConfigSections(): readonly ConfigRegistrySection[] {
  return [...configSections().values()].sort((a, b) => a.title.localeCompare(b.title))
}

export function getConfigRows(ctx: ExtensionCommandContext): readonly ConfigRegistryRow[] {
  return getConfigSections().flatMap((section) => getConfigSectionRows(section, ctx))
}

export function getConfigSectionRows(
  section: ConfigRegistrySection,
  ctx: ExtensionCommandContext
): readonly ConfigRegistryRow[] {
  return typeof section.rows === 'function' ? section.rows(ctx) : section.rows
}

export function formatConfigRegistryStatus(ctx: ExtensionCommandContext): string {
  const parts = getConfigSections().flatMap((section) => {
    try {
      return section.status?.(ctx) ?? []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `${section.title}: ${message}`
    }
  })
  return parts.length ? parts.join('\n') : 'No config sections registered.'
}

export function configRowSource(row: ConfigRegistryRow, ctx: ExtensionCommandContext): string | undefined {
  return typeof row.source === 'function' ? row.source(ctx) : row.source
}
