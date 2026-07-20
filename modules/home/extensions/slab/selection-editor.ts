import { copyToClipboard, CustomEditor, type KeybindingsManager } from '@earendil-works/pi-coding-agent'
import { decodeKittyPrintable, type EditorTheme, matchesKey, type TUI } from '@earendil-works/pi-tui'
import {
  deleteRange,
  rangeOnVisualLine,
  selectedRange,
  styleTextRange,
  textInRange,
  type TextPosition,
  type TextRange,
  type VisualLine
} from './selection.ts'

const PASTE_MARKER_PATTERN = /\[paste #(\d+)( (?:\+\d+ lines|\d+ chars))?\]/g

const DELETE_SELECTION_ACTIONS = [
  'tui.editor.deleteToLineEnd',
  'tui.editor.deleteToLineStart',
  'tui.editor.deleteWordBackward',
  'tui.editor.deleteWordForward',
  'tui.editor.deleteCharBackward',
  'tui.editor.deleteCharForward'
] as const

const CLEAR_SELECTION_ACTIONS = [
  'tui.editor.cursorUp',
  'tui.editor.cursorDown',
  'tui.editor.cursorWordLeft',
  'tui.editor.cursorWordRight',
  'tui.editor.cursorLineStart',
  'tui.editor.cursorLineEnd',
  'tui.editor.jumpForward',
  'tui.editor.jumpBackward',
  'tui.editor.pageUp',
  'tui.editor.pageDown'
] as const

interface EditorStateInternals {
  lines: string[]
  cursorLine: number
  cursorCol: number
}

interface UndoStackInternals {
  stack: unknown[]
  readonly length: number
}

interface EditorInternals {
  state: EditorStateInternals
  lastWidth: number
  scrollOffset: number
  pastes: Map<number, string>
  pasteCounter: number
  lastAction: unknown
  preferredVisualCol: number | null
  snappedFromCursorCol: number | null
  undoStack: UndoStackInternals
  buildVisualLineMap(width: number): VisualLine[]
  pushUndoSnapshot(): void
  setCursorCol(col: number): void
  exitHistoryBrowsing(): void
  cancelAutocomplete(): void
  moveCursor(deltaLine: number, deltaCol: number): void
  moveWordBackwards(): void
  moveWordForwards(): void
  moveToLineStart(): void
  moveToLineEnd(): void
  pageScroll(direction: -1 | 1): void
  deleteWordBackwards(): void
}

function editorInternals(editor: SelectionEditor): EditorInternals {
  // pi-tui uses TypeScript-private fields rather than #private runtime fields.
  // Keep version-coupled access in this adapter until Pi exposes selection.
  return editor as unknown as EditorInternals
}

function isModifyOtherKeysPrintable(data: string): boolean {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/)
  if (!match) return false
  const modifier = Number(match[1])
  const codepoint = Number(match[2])
  return (modifier === 1 || modifier === 2) && Number.isFinite(codepoint) && codepoint >= 32
}

export class SelectionEditor extends CustomEditor {
  private selectionAnchor: TextPosition | undefined

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly selectionKeybindings: KeybindingsManager,
    private readonly styleSelection: (text: string) => string
  ) {
    super(tui, theme, selectionKeybindings)
  }

  override setText(text: string): void {
    this.selectionAnchor = undefined
    super.setText(text)
  }

  override insertTextAtCursor(text: string): void {
    const undoDepth = this.deleteSelection()
    super.insertTextAtCursor(text)
    if (undoDepth !== undefined) this.discardUndoSnapshotsAfter(undoDepth)
  }

  override handleInput(data: string): void {
    if (this.extendSelection(data)) {
      this.finishInput()
      return
    }

    const range = this.selection()
    if (!range) this.selectionAnchor = undefined
    if (range && this.selectionKeybindings.matches(data, 'tui.input.copy')) {
      void copyToClipboard(this.expandedSelectionText(range)).catch(() => {})
      this.tui.requestRender()
      return
    }

    if (range && this.selectionKeybindings.matches(data, 'app.interrupt')) {
      this.selectionAnchor = undefined
      this.tui.requestRender()
      return
    }

    if (this.isCtrlBackspace(data)) {
      if (range) this.deleteSelection()
      else editorInternals(this).deleteWordBackwards()
      this.finishInput()
      return
    }

    if (range && DELETE_SELECTION_ACTIONS.some((action) => this.selectionKeybindings.matches(data, action))) {
      this.deleteSelection()
      this.finishInput()
      return
    }

    if (range && this.selectionKeybindings.matches(data, 'tui.editor.cursorLeft')) {
      this.collapseSelection(range.start)
      this.finishInput()
      return
    }

    if (range && this.selectionKeybindings.matches(data, 'tui.editor.cursorRight')) {
      this.collapseSelection(range.end)
      this.finishInput()
      return
    }

    if (range && this.replacesSelection(data)) {
      const undoDepth = this.deleteSelection()
      super.handleInput(data)
      if (undoDepth !== undefined) this.discardUndoSnapshotsAfter(undoDepth)
      this.finishInput()
      return
    }

    if (range && CLEAR_SELECTION_ACTIONS.some((action) => this.selectionKeybindings.matches(data, action))) {
      this.selectionAnchor = undefined
    }

    super.handleInput(data)
    this.finishInput()
  }

  override render(width: number): string[] {
    return this.renderSelection(super.render(width))
  }

  private selection(): TextRange | undefined {
    return selectedRange(this.selectionAnchor, this.getCursor())
  }

  private extendSelection(data: string): boolean {
    const internals = editorInternals(this)
    let move: (() => void) | undefined

    if (matchesKey(data, 'ctrl+shift+left')) move = () => internals.moveWordBackwards()
    else if (matchesKey(data, 'ctrl+shift+right')) move = () => internals.moveWordForwards()
    else if (matchesKey(data, 'ctrl+shift+home')) {
      move = () => {
        internals.state.cursorLine = 0
        internals.setCursorCol(0)
      }
    } else if (matchesKey(data, 'ctrl+shift+end')) {
      move = () => {
        const line = internals.state.lines.length - 1
        internals.state.cursorLine = line
        internals.setCursorCol(internals.state.lines[line]?.length ?? 0)
      }
    } else if (matchesKey(data, 'shift+left')) move = () => internals.moveCursor(0, -1)
    else if (matchesKey(data, 'shift+right')) move = () => internals.moveCursor(0, 1)
    else if (matchesKey(data, 'shift+up')) move = () => internals.moveCursor(-1, 0)
    else if (matchesKey(data, 'shift+down')) move = () => internals.moveCursor(1, 0)
    else if (matchesKey(data, 'shift+home')) move = () => internals.moveToLineStart()
    else if (matchesKey(data, 'shift+end')) move = () => internals.moveToLineEnd()
    else if (matchesKey(data, 'shift+pageUp')) move = () => internals.pageScroll(-1)
    else if (matchesKey(data, 'shift+pageDown')) move = () => internals.pageScroll(1)

    if (!move) return false
    this.selectionAnchor ??= { ...this.getCursor() }
    move()
    this.tui.requestRender()
    return true
  }

  private collapseSelection(position: TextPosition): void {
    const internals = editorInternals(this)
    internals.state.cursorLine = position.line
    internals.setCursorCol(position.col)
    this.selectionAnchor = undefined
    this.tui.requestRender()
  }

  private deleteSelection(): number | undefined {
    const range = this.selection()
    if (!range) return undefined

    const internals = editorInternals(this)
    internals.cancelAutocomplete()
    internals.exitHistoryBrowsing()
    internals.lastAction = null
    internals.pushUndoSnapshot()

    const result = deleteRange(internals.state.lines, range)
    internals.state.lines = result.lines
    internals.state.cursorLine = result.cursor.line
    internals.setCursorCol(result.cursor.col)
    internals.preferredVisualCol = null
    internals.snappedFromCursorCol = null
    this.reconcilePasteRegistry(internals)
    this.selectionAnchor = undefined
    this.onChange?.(this.getText())
    this.tui.requestRender()
    return internals.undoStack.length
  }

  private expandedSelectionText(range: TextRange): string {
    let text = textInRange(this.getLines(), range)
    for (const [id, content] of editorInternals(this).pastes) {
      const marker = new RegExp(`\\[paste #${id}( (?:\\+\\d+ lines|\\d+ chars))?\\]`, 'g')
      text = text.replace(marker, () => content)
    }
    return text
  }

  private reconcilePasteRegistry(internals: EditorInternals): void {
    if (internals.pastes.size === 0) return

    const text = internals.state.lines.join('\n')
    const present = new Set([...text.matchAll(PASTE_MARKER_PATTERN)].map((match) => Number(match[1])))
    const kept = [...internals.pastes.entries()]
      .filter(([id]) => present.has(id))
      .sort(([left], [right]) => left - right)
    const remap = new Map(kept.map(([id], index) => [id, index + 1]))
    internals.pastes = new Map(kept.map(([id, value]) => [remap.get(id)!, value]))
    internals.pasteCounter = internals.pastes.size
    internals.state.lines = internals.state.lines.map((line) =>
      line.replace(PASTE_MARKER_PATTERN, (full, idText: string, suffix: string | undefined) => {
        const nextId = remap.get(Number(idText))
        return nextId === undefined ? full : `[paste #${nextId}${suffix ?? ''}]`
      })
    )
  }

  private discardUndoSnapshotsAfter(depth: number): void {
    const stack = editorInternals(this).undoStack.stack
    if (Array.isArray(stack) && stack.length > depth) stack.splice(depth)
  }

  private isCtrlBackspace(data: string): boolean {
    // Ghostty's legacy Ctrl+Backspace is Ctrl-H (0x08), which pi-tui otherwise
    // classifies as Backspace outside Windows. Plain Backspace remains 0x7f.
    return data === '\x08' || matchesKey(data, 'ctrl+backspace')
  }

  private replacesSelection(data: string): boolean {
    if (this.selectionKeybindings.matches(data, 'tui.input.newLine')) return true
    if (this.selectionKeybindings.matches(data, 'tui.editor.yank')) return true
    if (data.includes('\x1b[200~')) return true
    if (decodeKittyPrintable(data) !== undefined) return true
    if (isModifyOtherKeysPrintable(data)) return true
    return data.length > 0 && data.charCodeAt(0) >= 32
  }

  private finishInput(): void {
    const anchor = this.selectionAnchor
    if (anchor) {
      const anchorLine = this.getLines()[anchor.line]
      if (anchorLine === undefined || anchor.col > anchorLine.length) this.selectionAnchor = undefined
    }
    this.tui.requestRender()
  }

  private renderSelection(rawLines: string[]): string[] {
    const range = this.selection()
    if (!range) return rawLines

    const internals = editorInternals(this)
    const visualLines = internals.buildVisualLineMap(internals.lastWidth)
    const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3))
    const visibleVisualLines = visualLines.slice(internals.scrollOffset, internals.scrollOffset + maxVisibleLines)
    const result = [...rawLines]

    for (let index = 0; index < visibleVisualLines.length; index++) {
      const visualLine = visibleVisualLines[index]!
      const span = rangeOnVisualLine(
        range,
        visualLine,
        internals.state.lines[visualLine.logicalLine]?.length ?? 0
      )
      if (!span) continue
      const rawIndex = index + 1
      result[rawIndex] = styleTextRange(result[rawIndex] ?? '', span, this.styleSelection)
    }

    return result
  }
}
