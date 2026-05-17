import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { runCommit, runPr } from './actions'
import { formatConfigStatus } from './config'
import { openCommandsConfigDialog } from './dialog'

export default function commandsExtension(pi: ExtensionAPI) {
  pi.registerCommand('commit', {
    description: 'Commit staged changes. Optional prompt adds instructions. Configure with `/config`.',
    handler: async (args, ctx) => runCommit(pi, ctx, args)
  })

  pi.registerCommand('pr', {
    description: 'Create PR. Optional prompt adds instructions. Configure with `/config`.',
    handler: async (args, ctx) => runPr(pi, ctx, args)
  })

  pi.registerCommand('config', {
    description: 'Configure command model/thinking overrides.',
    handler: async (args, ctx) => {
      const value = args.trim()
      if (value === 'status') {
        ctx.ui.notify(formatConfigStatus(), 'info')
        return
      }
      if (value && value !== 'help' && value !== '--help' && value !== '-h') {
        ctx.ui.notify('Usage:\n/config\n/config status', 'error')
        return
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(formatConfigStatus(), 'info')
        return
      }
      openCommandsConfigDialog(ctx)
    }
  })
}
