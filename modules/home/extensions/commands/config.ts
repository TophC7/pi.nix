import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Api, Model } from '@mariozechner/pi-ai'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'

export const MANAGED_COMMANDS = ['commit', 'pr', 'compact', 'qa'] as const
export type ManagedCommand = (typeof MANAGED_COMMANDS)[number]

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface CommandModelConfig {
  readonly model?: string
  readonly thinking?: ThinkingLevel
}

export type CommandsConfig = Record<ManagedCommand, CommandModelConfig>

export type ConfigFile = Record<string, unknown> & Partial<Record<ManagedCommand | 'git', CommandModelConfig>>

export interface RestoreState {
  readonly command: ManagedCommand
  readonly model: Model<Api> | undefined
  readonly thinking: ThinkingLevel
}

export const CONFIG_PATH =
  process.env.PI_COMMAND_MODELS_CONFIG ?? join(process.env.HOME ?? '.', '.pi', 'agent', 'command-models.json')

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel)
}

export function readConfig(): ConfigFile {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (typeof config === 'object' && config !== null && !Array.isArray(config)) return config as ConfigFile
    throw new Error(`Invalid command config ${CONFIG_PATH}: expected object`)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {}
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${error.message}`)
    throw error
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function writeConfig(config: ConfigFile | CommandsConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, '\t')}\n`)
}

function sanitizeConfig(config: unknown): CommandModelConfig {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return {}
  const candidate = config as CommandModelConfig
  return {
    model: typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : undefined,
    thinking: isThinkingLevel(candidate.thinking) ? candidate.thinking : undefined
  }
}

export function getCommandsConfig(): CommandsConfig {
  const file = readConfig()
  const legacyGit = sanitizeConfig(file.git)
  return {
    commit: { ...legacyGit, ...sanitizeConfig(file.commit) },
    pr: { ...legacyGit, ...sanitizeConfig(file.pr) },
    compact: sanitizeConfig(file.compact),
    qa: sanitizeConfig(file.qa)
  }
}

export function getCommandConfig(command: ManagedCommand): CommandModelConfig {
  return getCommandsConfig()[command]
}

export function saveCommandConfig(command: ManagedCommand, commandConfig: CommandModelConfig): CommandsConfig {
  const next: ConfigFile = { ...readConfig(), [command]: sanitizeConfig(commandConfig) }
  writeConfig(next)
  return getCommandsConfig()
}

export function formatConfigStatus(config: CommandsConfig = getCommandsConfig()): string {
  return [
    '/config command models',
    ...MANAGED_COMMANDS.flatMap((command) => {
      const entry = config[command]
      return [`/${command} model: ${entry.model ?? 'default'}`, `/${command} thinking: ${entry.thinking ?? 'default'}`]
    }),
    `config: ${CONFIG_PATH}`
  ].join('\n')
}

export function resolveModel(ctx: ExtensionCommandContext, spec: string): Model<Api> | undefined | 'ambiguous' {
  const models = ctx.modelRegistry.getAll()
  const exactFull = models.find((model) => `${model.provider}/${model.id}` === spec)
  if (exactFull) return exactFull

  const slash = spec.indexOf('/')
  if (slash > 0) {
    const provider = spec.slice(0, slash)
    const id = spec.slice(slash + 1)
    const exactProvider = ctx.modelRegistry.find(provider, id)
    if (exactProvider) return exactProvider
  }

  const exactId = models.filter((model) => model.id === spec || model.name === spec)
  if (exactId.length === 1) return exactId[0]
  if (exactId.length > 1) return 'ambiguous'
  return undefined
}

export async function applyCommandConfig(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: ManagedCommand,
  config: CommandModelConfig = getCommandConfig(command)
): Promise<boolean> {
  if (config.model) {
    const model = resolveModel(ctx, config.model)
    if (model === 'ambiguous') {
      ctx.ui.notify(`Ambiguous /${command} model in ${CONFIG_PATH}: ${config.model}`, 'error')
      return false
    }
    if (!model) {
      ctx.ui.notify(`Model not found in ${CONFIG_PATH}: ${config.model}`, 'error')
      return false
    }
    const ok = await pi.setModel(model)
    if (!ok) {
      ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, 'error')
      return false
    }
  }

  if (config.thinking) pi.setThinkingLevel(config.thinking)
  return true
}

export function captureRestore(pi: ExtensionAPI, ctx: ExtensionCommandContext, command: ManagedCommand): RestoreState {
  return {
    command,
    model: ctx.model,
    thinking: pi.getThinkingLevel()
  }
}

export async function restoreCommandConfig(pi: ExtensionAPI, restore: RestoreState | undefined): Promise<void> {
  if (!restore) return
  if (restore.model) await pi.setModel(restore.model)
  pi.setThinkingLevel(restore.thinking)
}
