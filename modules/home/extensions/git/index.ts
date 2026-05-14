import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { type AutocompleteItem, fuzzyFilter } from '@mariozechner/pi-tui'
import {
  CONFIG_PATH,
  formatConfigStatus,
  getGitConfig,
  installGitActionRuntime,
  runCommit,
  runPr,
  saveGitConfig
} from './actions'
import { selectModelFromMenu, selectThinkingFromMenu } from './model-picker'

const GIT_SETTINGS = [
  {
    value: 'model',
    label: 'model',
    description: 'Pick and save shared /commit and /pr model'
  },
  {
    value: 'thinking',
    label: 'thinking',
    description: 'Pick and save shared /commit and /pr thinking level'
  },
  {
    value: 'status',
    label: 'status',
    description: 'Show shared git action config'
  },
  {
    value: 'reset',
    label: 'reset',
    description: 'Clear shared git action config'
  },
  { value: 'help', label: 'help', description: 'Show usage' }
] as const satisfies ReadonlyArray<{
  value: string
  label: string
  description: string
}>

type GitSetting = (typeof GIT_SETTINGS)[number]['value']

interface ParsedGitCommand {
  setting: GitSetting
  unknown?: string
}

function isGitSetting(value: string | undefined): value is GitSetting {
  return typeof value === 'string' && GIT_SETTINGS.some((setting) => setting.value === value)
}

function usage(): string {
  return [
    'Usage:',
    '/commit [prompt]',
    '/pr [prompt]',
    '/git model|thinking|status|reset',
    `Config: ${CONFIG_PATH}`
  ].join('\n')
}

function parseGitCommand(args: string | undefined): ParsedGitCommand {
  const value = args?.trim()
  if (!value || value === 'help' || value === '--help' || value === '-h') return { setting: 'help' }

  const [settingToken, ...rest] = value.split(/\s+/)
  if (!isGitSetting(settingToken)) return { setting: 'help', unknown: settingToken }
  if (rest.length > 0) return { setting: settingToken, unknown: rest.join(' ') }
  return { setting: settingToken }
}

function getGitCompletions(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.replace(/^\s+/, '')
  const trimmed = normalized.trim()
  if (trimmed.includes(' ') || (/\s$/.test(normalized) && trimmed)) return null

  const items = fuzzyFilter([...GIT_SETTINGS], trimmed, (setting) => setting.value).map((setting) => ({
    value: setting.value,
    label: setting.label,
    description: setting.description
  }))
  return items.length > 0 ? items : null
}

export default function gitExtension(pi: ExtensionAPI) {
  installGitActionRuntime(pi)

  pi.registerCommand('commit', {
    description: 'Commit staged changes. Optional prompt adds instructions. Configure with `/git ...`.',
    handler: async (args, ctx) => runCommit(pi, ctx, args)
  })

  pi.registerCommand('pr', {
    description: 'Create PR. Optional prompt adds instructions. Configure with `/git ...`.',
    handler: async (args, ctx) => runPr(pi, ctx, args)
  })

  pi.registerCommand('git', {
    description: 'Configure shared /commit and /pr model/thinking.',
    getArgumentCompletions: getGitCompletions,
    handler: async (args, ctx) => {
      const command = parseGitCommand(args)
      if (command.unknown) {
        ctx.ui.notify(`Unknown /git arg: ${command.unknown}\n${usage()}`, 'error')
        return
      }
      if (command.setting === 'help') {
        ctx.ui.notify(usage(), 'info')
        return
      }

      const config = getGitConfig()
      if (command.setting === 'model') {
        const model = await selectModelFromMenu(ctx, config.model)
        if (!model) return
        saveGitConfig({ ...config, model })
        ctx.ui.notify(`Saved /git model: ${model}`, 'info')
        return
      }
      if (command.setting === 'thinking') {
        const thinking = await selectThinkingFromMenu(ctx, config.thinking)
        if (!thinking) return
        saveGitConfig({ ...config, thinking })
        ctx.ui.notify(`Saved /git thinking: ${thinking}`, 'info')
        return
      }
      if (command.setting === 'reset') {
        saveGitConfig({})
        ctx.ui.notify('Cleared /git config', 'info')
        return
      }

      ctx.ui.notify(formatConfigStatus(config), 'info')
    }
  })
}
