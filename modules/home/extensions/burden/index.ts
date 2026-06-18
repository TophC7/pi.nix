import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { openDialog } from '@pi/lib/ui/dialog.ts'
import { buildBurdenReport } from './attribution.ts'
import { BurdenExplorer } from './explorer.ts'

export const BURDEN_COMMAND = 'burden' as const

export default function burden(pi: ExtensionAPI): void {
  pi.registerCommand(BURDEN_COMMAND, {
    description: 'Open first-party token attribution explorer',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return
      const report = buildBurdenReport(pi, ctx)
      openDialog(
        ctx,
        ({ theme, close }) =>
          new BurdenExplorer({
            report,
            theme,
            onClose: close
          }),
        { width: '98%', maxHeight: '94%', padding: 0, borderStyle: 'square' }
      )
    }
  })
}
