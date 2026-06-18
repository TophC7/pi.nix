import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { formatConfigRegistryStatus } from '@pi/lib/config-registry'
import { openConfigDialog } from './dialog.ts'

export default function configExtension(pi: ExtensionAPI) {
  pi.registerCommand('config', {
    description: 'Configure registered extension settings.',
    handler: async (args, ctx) => {
      const value = args.trim()
      if (value === 'status') {
        ctx.ui.notify(formatConfigRegistryStatus(ctx), 'info')
        return
      }
      if (value && value !== 'help' && value !== '--help' && value !== '-h') {
        ctx.ui.notify('Usage:\n/config\n/config status', 'error')
        return
      }
      if (value === 'help' || value === '--help' || value === '-h') {
        ctx.ui.notify('Usage:\n/config\n/config status', 'info')
        return
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(formatConfigRegistryStatus(ctx), 'info')
        return
      }
      openConfigDialog(ctx)
    }
  })
}
