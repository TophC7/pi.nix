import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readRuntimeProfileConfig, type RuntimeProfile } from '@pi/lib/runtime-profile'
export { THINKING_LEVELS, type ThinkingLevel } from '@pi/lib/runtime-profile'

export const COMMAND_PROFILE_IDS = ['commit', 'pr', 'compact'] as const
export type ManagedCommand = (typeof COMMAND_PROFILE_IDS)[number]

export type CommandModelConfig = RuntimeProfile

type ConfigFile = Record<string, unknown> & Partial<Record<ManagedCommand, CommandModelConfig>>

export const CONFIG_PATH =
  process.env.PI_COMMAND_MODELS_CONFIG ?? join(process.env.HOME ?? '.', '.pi', 'agent', 'command-models.json')

export function getCommandConfig(command: ManagedCommand): CommandModelConfig {
  return readCommandProfile(readConfig()[command], `${CONFIG_PATH} /${command}`)
}

export function saveCommandConfig(command: ManagedCommand, commandConfig: CommandModelConfig): void {
  const next: ConfigFile = {
    ...readConfig(),
    [command]: readCommandProfile(commandConfig, `${CONFIG_PATH} /${command}`)
  }
  writeConfig(next)
}

function readConfig(): ConfigFile {
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

function writeConfig(config: ConfigFile): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, '\t')}\n`)
}

function readCommandProfile(config: unknown, source: string): CommandModelConfig {
  return readRuntimeProfileConfig(config, source)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
