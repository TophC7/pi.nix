import type { ExtensionCommandContext, Theme } from '@mariozechner/pi-coding-agent'
import { Key, matchesKey, truncateToWidth, type Component } from '@mariozechner/pi-tui'
import {
  openDialog,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader,
  type DialogContent
} from '@pi/lib/ui/dialog.ts'
import type { BuddyActionResult } from '../actions.ts'
import { getCompanion } from '../core/companion.ts'
import type { Companion } from '../core/types.ts'
import { getBuddyDatabase } from '../db/index.ts'
import { renderSharePreview } from './share-preview.ts'

export function openBuddySharePreview(ctx: unknown): BuddyActionResult {
  const { db } = getBuddyDatabase()
  const companion = getCompanion(db)
  if (!companion) {
    return { text: 'Hatch a companion first, then run /buddy share.', isError: true }
  }

  if (!hasInteractiveUi(ctx)) {
    return { text: 'Buddy share preview requires interactive Pi UI. Run /buddy share in the TUI.', isError: true }
  }

  openDialog(ctx, ({ theme, close }) => new BuddyShareDialog(theme, companion, close), {
    width: '80%',
    maxHeight: '80%',
    minWidth: 52,
    maxWidth: 76,
    padding: 1,
    borderStyle: 'rounded'
  })

  return { text: 'Buddy share preview opened. Screenshot the terminal overlay manually.', details: { companion } }
}

function hasInteractiveUi(ctx: unknown): ctx is ExtensionCommandContext {
  return typeof (ctx as { ui?: { custom?: unknown } } | null)?.ui?.custom === 'function'
}

class BuddyShareDialog implements DialogContent {
  constructor(
    private readonly theme: Theme,
    private readonly companion: Companion,
    private readonly close: () => void
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(20, width)
    const body = renderSharePreview(this.companion, safeWidth, this.theme)
    return [
      renderDialogHeader({ title: 'Buddy Share Preview', theme: this.theme, width: safeWidth }),
      renderDialogDivider({ theme: this.theme, width: safeWidth }),
      ...body.map((line) => truncateToWidth(line, safeWidth, '…', true)),
      renderDialogDivider({ theme: this.theme, width: safeWidth }),
      renderDialogFooter({
        theme: this.theme,
        width: safeWidth,
        keys: [{ key: 'Esc', label: 'close' }],
        status: 'manual screenshot'
      })
    ]
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) this.close()
  }
}
