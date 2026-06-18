import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('clear', {
    description: 'Clear current conversation messages and start fresh',
    handler: async (_args, ctx) => {
      const confirm = await ctx.ui.confirm(
        'Clear Conversation',
        'Are you sure you want to clear the conversation? This deletes all messages and starts a fresh session.'
      )

      if (!confirm) {
        ctx.ui.notify('Clear cancelled', 'info')
        return
      }

      await ctx.newSession({
        withSession: async (newCtx) => {
          newCtx.ui.notify('Conversation cleared', 'success')
        }
      })
    }
  })
}
