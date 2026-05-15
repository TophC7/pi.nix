// Pi extension: appends a "caveman mode" instruction block to the agent system
// prompt to bias output toward terse fragments. Compression is qualitative —
// intensity is selectable; no measured output-size guarantee.
// Based on https://github.com/JuliusBrussee/caveman.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { ListDialog } from './pi-lib/ui/components.ts'

const LEVELS = ['off', 'lite', 'full', 'ultra', 'micro'] as const
type Level = (typeof LEVELS)[number]

const LEVEL_OPTIONS: { value: Level; label: string; description: string }[] = [
  { value: 'off', label: 'off', description: 'Disable caveman mode' },
  { value: 'lite', label: 'lite', description: 'Professional, no fluff' },
  { value: 'full', label: 'full', description: 'Classic caveman' },
  { value: 'ultra', label: 'ultra', description: 'Maximum compression' },
  {
    value: 'micro',
    label: 'micro',
    description: 'Experimental prompt-minimized mode'
  }
]

interface CavemanConfig {
  defaultLevel: Level
}

const CONFIG_DIR = join(homedir(), '.pi', 'agent')
const CONFIG_PATH = join(CONFIG_DIR, 'caveman.json')
const CAVEMAN_LEVEL_ENTRY_TYPE = 'caveman-level'
const DEFAULT_CONFIG: CavemanConfig = { defaultLevel: 'full' }
let saveConfigQueue: Promise<void> = Promise.resolve()

async function loadConfig(): Promise<CavemanConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      defaultLevel: LEVELS.includes(parsed.defaultLevel) ? parsed.defaultLevel : DEFAULT_CONFIG.defaultLevel
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

async function saveConfig(config: CavemanConfig): Promise<void> {
  const snapshot = JSON.stringify(config, null, 2) + '\n'
  saveConfigQueue = saveConfigQueue.then(async () => {
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(CONFIG_PATH, snapshot, 'utf8')
  })
  return saveConfigQueue
}

const BASE = `\
IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. \
All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), \
pleasantries, hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`

const MICRO_PROMPT = `# Token efficiency
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].`

const INTENSITY: Record<Exclude<Level, 'off' | 'micro'>, string> = {
  lite: `\
No filler/hedging. Keep articles + full sentences. Professional but tight.
Example: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

  full: `\
Drop articles, fragments OK, short synonyms.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

  ultra: `\
Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y).
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."`
}

const SAFETY = `\
Auto-clarity: drop caveman for security warnings, irreversible action confirmations, \
or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.`

export default function caveman(pi: ExtensionAPI) {
  let level: Level = 'off'
  let config: CavemanConfig = { ...DEFAULT_CONFIG }
  let configLoadPromise: Promise<void> | null = null

  const ensureConfigLoaded = async () => {
    if (!configLoadPromise) {
      configLoadPromise = (async () => {
        config = await loadConfig()
        if (level === 'off' && config.defaultLevel !== 'off') {
          level = config.defaultLevel
        }
      })()
    }
    await configLoadPromise
  }

  function applyLevel(next: Level): void {
    if (next === level && config.defaultLevel === next) return
    level = next
    pi.appendEntry(CAVEMAN_LEVEL_ENTRY_TYPE, { level })
    if (config.defaultLevel !== next) {
      config = { ...config, defaultLevel: next }
      void saveConfig(config)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    await ensureConfigLoaded()

    let sessionLevel: Level | null = null
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === CAVEMAN_LEVEL_ENTRY_TYPE) {
        sessionLevel = (entry.data as { level: Level })?.level ?? null
      }
    }

    if (sessionLevel !== null) {
      level = sessionLevel
    } else if (config.defaultLevel !== 'off') {
      level = config.defaultLevel
      pi.appendEntry(CAVEMAN_LEVEL_ENTRY_TYPE, { level })
    }
  })

  pi.registerCommand('caveman', {
    description: 'Open caveman level picker, or pass a level directly (off, lite, full, ultra, micro)',
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase()
      const items = LEVEL_OPTIONS.filter((item) => item.value.startsWith(normalized))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      await ensureConfigLoaded()
      const arg = args?.trim().toLowerCase()

      if (arg) {
        if (!LEVELS.includes(arg as Level)) {
          ctx.ui.notify(`Unknown caveman level "${arg}". Use: ${LEVELS.join(', ')}`, 'error')
          return
        }
        applyLevel(arg as Level)
        ctx.ui.notify(arg === 'off' ? 'Caveman off.' : `Caveman: ${arg}`, 'info')
        return
      }

      if (!ctx.hasUI) {
        ctx.ui.notify('Pass a level when running non-interactively', 'warning')
        return
      }

      const picked = await openLevelPicker(ctx, level)
      if (picked === undefined) return
      applyLevel(picked)
      ctx.ui.notify(picked === 'off' ? 'Caveman off.' : `Caveman: ${picked}`, 'info')
    }
  })

  async function openLevelPicker(ctx: ExtensionCommandContext, current: Level): Promise<Level | undefined> {
    return ctx.ui.custom<Level | undefined>((tui, theme, _keybindings, done) => {
      const currentIndex = Math.max(
        0,
        LEVEL_OPTIONS.findIndex((item) => item.value === current)
      )
      const list = new ListDialog({
        title: theme.fg('accent', theme.bold('Caveman level')),
        items: LEVEL_OPTIONS.map((option) => ({
          value: option.value,
          label: `${option.value === current ? theme.fg('accent', '●') : ' '} ${option.label}`,
          description: option.description
        })),
        visibleRows: LEVEL_OPTIONS.length,
        initialIndex: currentIndex,
        dim: (text) => theme.fg('dim', text),
        onSelect: done,
        onCancel: () => done(undefined)
      })
      return {
        render: (width: number) => list.render(width),
        invalidate: () => list.invalidate(),
        handleInput: (data: string) => {
          if (list.handleInput(data)) tui.requestRender()
        }
      }
    })
  }

  pi.on('before_agent_start', async (event) => {
    await ensureConfigLoaded()
    if (level === 'off') return
    if (level === 'micro') {
      return { systemPrompt: `${event.systemPrompt}\n\n${MICRO_PROMPT}` }
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${BASE}\n\n${INTENSITY[level]}\n\n${SAFETY}`
    }
  })
}
