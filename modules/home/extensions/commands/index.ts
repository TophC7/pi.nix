import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerRuntimeProfileConfigSection } from '@pi/lib/config-registry'
import { runCommit, runPr } from './actions'
import { COMMAND_PROFILE_IDS, CONFIG_PATH, getCommandConfig, saveCommandConfig } from './config'

const COMMAND_DESCRIPTIONS: Record<(typeof COMMAND_PROFILE_IDS)[number], string> = {
  commit: 'One-shot prompt that commits currently staged changes.',
  pr: 'One-shot prompt that creates pull request text from current branch changes.',
  compact: 'Core session compaction runtime profile.'
}

export default function commandsExtension(pi: ExtensionAPI) {
  registerCommandsConfigSection()
  pi.registerCommand('commit', {
    description: 'Commit staged changes. Optional prompt adds instructions. Configure with `/config`.',
    handler: async (args, ctx) => runCommit(pi, ctx, args)
  })

  pi.registerCommand('pr', {
    description: 'Create PR. Optional prompt adds instructions. Configure with `/config`.',
    handler: async (args, ctx) => runPr(pi, ctx, args)
  })
}

function registerCommandsConfigSection(): void {
  registerRuntimeProfileConfigSection({
    id: 'commands.workflow',
    title: 'Workflow commands',
    description: 'Runtime profiles for command follow-up prompts.',
    profiles: COMMAND_PROFILE_IDS.map((command) => ({
      id: `commands.${command}`,
      label: `/${command}`,
      description: COMMAND_DESCRIPTIONS[command],
      source: CONFIG_PATH,
      get: () => getCommandConfig(command),
      set: (profile) => saveCommandConfig(command, profile)
    }))
  })
}
