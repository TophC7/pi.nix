// A prompt toggle is a fixed standing system instruction with persisted on/off
// state. SOUL.md remains the charter; toggles constrain one optional axis and
// append their prompt before each agent turn.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

const CONFIG_DIR = join(homedir(), '.pi', 'agent')
const LEGACY_ON_LEVELS = new Set(['lite', 'full', 'ultra', 'micro'])

export interface PromptToggleOptions {
  /** Slash command name, config file stem, and session entry prefix. */
  readonly name: string
  /** Human-facing name used in notifications. */
  readonly label: string
  /** Fixed instruction appended while enabled. */
  readonly prompt: string
  readonly defaultEnabled?: boolean
}

export function definePromptToggle(options: PromptToggleOptions): (pi: ExtensionAPI) => void {
  const configPath = join(CONFIG_DIR, `${options.name}.json`)
  const entryType = `${options.name}-enabled`
  const legacyEntryType = `${options.name}-level`
  const prompt = options.prompt.trim()
  const builtInDefault = options.defaultEnabled ?? true

  return function promptToggleExtension(pi: ExtensionAPI): void {
    let enabled = builtInDefault
    let defaultEnabled = builtInDefault
    let passthrough: Record<string, unknown> = {}
    let configLoad: Promise<void> | null = null
    let saveQueue: Promise<void> = Promise.resolve()

    function load(): Promise<void> {
      configLoad ??= (async () => {
        let raw: string
        try {
          raw = await readFile(configPath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            console.error(`[${options.name}] cannot read ${configPath}, using defaults:`, error)
          }
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          console.error(`[${options.name}] ${configPath} is not valid JSON, using defaults:`, error)
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          console.error(`[${options.name}] ${configPath} is not an object, using defaults.`)
          return
        }

        const {
          enabled: stored,
          defaultLevel: legacy,
          ...rest
        } = parsed as {
          enabled?: unknown
          defaultLevel?: unknown
        }
        passthrough = rest

        if (typeof stored === 'boolean') {
          enabled = stored
          defaultEnabled = stored
          return
        }
        if (stored !== undefined) {
          console.error(
            `[${options.name}] ${configPath} has non-boolean enabled ${JSON.stringify(stored)}, using ${defaultEnabled}.`
          )
          return
        }

        // One-way compatibility with the former level dial. Any active level is
        // simply on; the next explicit toggle rewrites the file as { enabled }.
        if (legacy === 'off') {
          enabled = false
          defaultEnabled = false
        } else if (typeof legacy === 'string' && LEGACY_ON_LEVELS.has(legacy)) {
          enabled = true
          defaultEnabled = true
        } else if (legacy !== undefined) {
          console.error(
            `[${options.name}] ${configPath} has unknown defaultLevel ${JSON.stringify(legacy)}, using ${defaultEnabled}.`
          )
        }
      })()
      return configLoad
    }

    function save(): Promise<void> {
      const snapshot = `${JSON.stringify({ ...passthrough, enabled: defaultEnabled }, null, 2)}\n`
      saveQueue = saveQueue.then(
        () => writeSnapshot(snapshot),
        () => writeSnapshot(snapshot)
      )
      return saveQueue
    }

    async function writeSnapshot(snapshot: string): Promise<void> {
      await mkdir(CONFIG_DIR, { recursive: true })
      await writeFile(configPath, snapshot, 'utf8')
    }

    async function apply(next: boolean): Promise<void> {
      if (next !== enabled) {
        enabled = next
        pi.appendEntry(entryType, { enabled: next })
      }
      if (next !== defaultEnabled) {
        defaultEnabled = next
        await save()
      }
    }

    async function select(ctx: ExtensionCommandContext, next: boolean): Promise<void> {
      try {
        await apply(next)
      } catch (error) {
        ctx.ui.notify(`${options.label} changed, but could not save the default: ${error}`, 'error')
      }
      ctx.ui.notify(`${options.label} ${next ? 'on' : 'off'}.`, 'info')
    }

    pi.on('session_start', async (_event, ctx) => {
      await load()

      let restored: boolean | null = null
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== 'custom') continue
        if (entry.customType === entryType) {
          const candidate = (entry.data as { enabled?: unknown })?.enabled
          if (typeof candidate === 'boolean') restored = candidate
        } else if (entry.customType === legacyEntryType) {
          const candidate = (entry.data as { level?: unknown })?.level
          if (candidate === 'off') restored = false
          else if (typeof candidate === 'string' && LEGACY_ON_LEVELS.has(candidate)) restored = true
        }
      }

      if (restored === null) pi.appendEntry(entryType, { enabled })
      else enabled = restored
    })

    pi.registerCommand(options.name, {
      description: `Toggle ${options.name}, or pass on/off`,
      getArgumentCompletions: (prefix: string) => {
        const normalized = prefix.trim().toLowerCase()
        const items = [
          { value: 'on', label: 'on', description: `Enable ${options.name}` },
          { value: 'off', label: 'off', description: `Disable ${options.name}` }
        ].filter((item) => item.value.startsWith(normalized))
        return items.length > 0 ? items : null
      },
      handler: async (args, ctx) => {
        await load()
        const arg = args?.trim().toLowerCase()
        if (arg && arg !== 'on' && arg !== 'off') {
          ctx.ui.notify(`Unknown ${options.name} state "${arg}". Use: on, off`, 'error')
          return
        }
        await select(ctx, arg ? arg === 'on' : !enabled)
      }
    })

    pi.on('before_agent_start', async (event) => {
      await load()
      if (!enabled) return
      const base = event.systemPrompt ? `${event.systemPrompt}\n\n` : ''
      return { systemPrompt: `${base}${prompt}` }
    })
  }
}
