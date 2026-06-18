import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'
import {
  fitLine,
  openDialog,
  padLine,
  renderDialogDivider,
  renderDialogFooter,
  renderDialogHeader,
  type DialogContent
} from '@pi/lib/ui'
import { buddyHatch, buddyMode, buddyMute, buddyPet, buddyUnmute, type BuddyActionResult } from '../actions.ts'
import { getCompanion } from '../core/companion.ts'
import type { Companion } from '../core/types.ts'
import { getActiveReaction } from '../core/reactions.ts'
import { getBuddyDatabase } from '../db/index.ts'
import { renderBuddyDossier } from './dossier.ts'

const FOOTER_KEYS = [
  { key: '↑/↓', label: 'row' },
  { key: 'Enter', label: 'apply' },
  { key: 'Esc', label: 'close' }
] as const

type DialogRow = {
  readonly label: string
  readonly value: string
  readonly hint: string
  readonly disabled?: boolean
  readonly run?: () => BuddyActionResult
}

export function openBuddyDialog(ctx: unknown): BuddyActionResult {
  if (!hasInteractiveUi(ctx)) {
    return { text: 'Buddy dialog requires interactive Pi UI. Run /buddy in the TUI.', isError: true }
  }

  openDialog(ctx, ({ theme, close }) => new BuddyDialog(ctx, theme, close), {
    width: '96%',
    maxHeight: '94%',
    minWidth: 60,
    padding: 0,
    borderStyle: 'square'
  })

  return { text: 'Buddy dialog opened.' }
}

export function hasInteractiveUi(ctx: unknown): ctx is ExtensionCommandContext {
  return typeof (ctx as { ui?: { custom?: unknown } } | null)?.ui?.custom === 'function'
}

class BuddyDialog implements DialogContent {
  private rowIndex = 0
  private status = 'ready'

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly theme: Theme,
    private readonly close: () => void
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.close()
      return
    }
    if (matchesKey(data, Key.up) || data === 'k') this.moveRow(-1)
    else if (matchesKey(data, Key.down) || data === 'j') this.moveRow(1)
    else if (matchesKey(data, Key.enter) || data === ' ') this.runSelected()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(42, width)
    const state = readBuddyState()
    const title = state.companion
      ? `Buddy  ·  ${state.companion.name} the ${state.companion.species}`
      : 'Buddy  ·  no companion yet'

    const lines: string[] = [
      renderDialogHeader({ title, theme: this.theme, width: safeWidth }),
      renderDialogDivider({ theme: this.theme, width: safeWidth }),
      ...this.renderHero(state, safeWidth),
      renderDialogDivider({ theme: this.theme, width: safeWidth }),
      ...this.renderRows(state.companion, safeWidth),
      renderDialogDivider({ theme: this.theme, width: safeWidth }),
      renderDialogFooter({ theme: this.theme, width: safeWidth, keys: FOOTER_KEYS, status: this.status })
    ]

    return lines.map((line) => truncateToWidth(line, safeWidth, '…', true))
  }

  private renderHero(state: BuddyState, width: number): string[] {
    if (state.error) return [`  ${this.theme.fg('error', state.error)}`]
    const companion = state.companion
    if (!companion) {
      return [
        `  ${this.theme.fg('muted', 'No Buddy hatched.')}`,
        `  ${this.theme.fg('dim', 'Enter on Hatch creates one. Nothing auto-hatches.')}`
      ]
    }

    const bodyWidth = Math.max(44, width - 4)
    const lines = renderBuddyDossier(companion, bodyWidth, this.theme).map((line) => `  ${line}`)
    if (state.reaction?.text) lines.push(`  ${fitLine(`“${state.reaction.text}”`, bodyWidth)}`)
    return lines
  }

  private renderRows(companion: Companion | null, width: number): string[] {
    const rows = this.rows(companion)
    if (this.rowIndex >= rows.length) this.rowIndex = Math.max(0, rows.length - 1)
    const labelWidth = Math.max(14, Math.min(22, Math.floor(width * 0.28)))
    const valueWidth = Math.max(10, Math.min(18, Math.floor(width * 0.22)))
    const out = [`  ${this.theme.fg('muted', this.theme.bold('ACTIONS / SETTINGS'))}`]

    rows.forEach((row, index) => {
      const selected = index === this.rowIndex
      const cursor = selected ? this.theme.fg('accent', this.theme.bold('›')) : ' '
      const label = padLine(fitLine(row.label, labelWidth), labelWidth)
      const value = padLine(fitLine(row.value, valueWidth), valueWidth)
      const styledLabel = row.disabled ? this.theme.fg('dim', label) : selected ? this.theme.bold(label) : label
      const styledValue = row.disabled ? this.theme.fg('dim', value) : selected ? this.theme.fg('accent', value) : this.theme.fg('muted', value)
      out.push(fitLine(` ${cursor} ${styledLabel}  ${styledValue}`, width))
      if (selected) out.push(fitLine(`   ${this.theme.fg('dim', row.hint)}`, width))
    })

    return out
  }

  private rows(companion: Companion | null): DialogRow[] {
    if (!companion) {
      return [
        {
          label: 'Hatch',
          value: 'new buddy',
          hint: 'Explicitly hatch a local Pi Buddy under ~/.pi/agent/state/buddy.',
          run: () => buddyHatch()
        }
      ]
    }

    return [
      { label: 'Pet', value: '+XP', hint: 'Give a tiny session XP bump.', run: () => buddyPet() },
      {
        label: 'Voice mode',
        value: companion.observerMode,
        hint: 'Cycle backseat → skillcoach → both. Controls prompt personality.',
        run: () => buddyMode({ mode: nextVoiceMode(companion.observerMode) })
      },
      {
        label: 'Guard mode',
        value: companion.guardMode ? 'on' : 'off',
        hint: 'Toggle reasoning graph observations and detector nudges.',
        run: () => buddyMode({ guard: companion.guardMode ? 'off' : 'on' })
      },
      {
        label: companion.mood === 'muted' ? 'Unmute' : 'Mute',
        value: companion.mood === 'muted' ? 'muted' : 'active',
        hint: 'Mute keeps state but quiets Buddy reactions.',
        run: () => (companion.mood === 'muted' ? buddyUnmute() : buddyMute())
      }
    ]
  }

  private moveRow(direction: -1 | 1): void {
    const count = this.rows(readBuddyState().companion).length
    if (count === 0) return
    this.rowIndex = (this.rowIndex + direction + count) % count
  }

  private runSelected(): void {
    const row = this.rows(readBuddyState().companion)[this.rowIndex]
    if (!row?.run || row.disabled) return
    const result = row.run()
    this.status = summarizeResult(result)
    if (result.isError) this.ctx.ui.notify(result.text, 'warning')
  }
}

interface BuddyState {
  readonly companion: Companion | null
  readonly reaction?: { readonly text?: string }
  readonly error?: string
}

function readBuddyState(): BuddyState {
  try {
    const { db } = getBuddyDatabase()
    const companion = getCompanion(db)
    return { companion, reaction: companion ? getActiveReaction(db, companion.id) ?? undefined : undefined }
  } catch (error) {
    return { companion: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function nextVoiceMode(mode: string): string {
  if (mode === 'backseat') return 'skillcoach'
  if (mode === 'skillcoach') return 'both'
  return 'backseat'
}

function summarizeResult(result: BuddyActionResult): string {
  if (result.isError) return 'error'
  const companion = (result.details as { companion?: Companion } | undefined)?.companion
  if (companion) return `${companion.name} updated`
  return result.text.split('\n', 1)[0] || 'updated'
}
