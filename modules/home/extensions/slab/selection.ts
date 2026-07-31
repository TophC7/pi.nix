export interface TextPosition {
  line: number
  col: number
}

export interface TextRange {
  start: TextPosition
  end: TextPosition
}

export interface VisualLine {
  logicalLine: number
  startCol: number
  length: number
}

export interface RelativeRange {
  start: number
  end: number
}

export function comparePositions(left: TextPosition, right: TextPosition): number {
  if (left.line !== right.line) return left.line - right.line
  return left.col - right.col
}

export function selectedRange(anchor: TextPosition | undefined, cursor: TextPosition): TextRange | undefined {
  if (!anchor || comparePositions(anchor, cursor) === 0) return undefined
  return comparePositions(anchor, cursor) < 0
    ? { start: { ...anchor }, end: { ...cursor } }
    : { start: { ...cursor }, end: { ...anchor } }
}

export function textInRange(lines: readonly string[], range: TextRange): string {
  if (range.start.line === range.end.line) {
    return (lines[range.start.line] ?? '').slice(range.start.col, range.end.col)
  }

  return [
    (lines[range.start.line] ?? '').slice(range.start.col),
    ...lines.slice(range.start.line + 1, range.end.line),
    (lines[range.end.line] ?? '').slice(0, range.end.col)
  ].join('\n')
}

export function deleteRange(lines: readonly string[], range: TextRange): { lines: string[]; cursor: TextPosition } {
  const before = (lines[range.start.line] ?? '').slice(0, range.start.col)
  const after = (lines[range.end.line] ?? '').slice(range.end.col)
  const next = [...lines.slice(0, range.start.line), `${before}${after}`, ...lines.slice(range.end.line + 1)]

  return {
    lines: next.length > 0 ? next : [''],
    cursor: { ...range.start }
  }
}

export function rangeOnVisualLine(
  range: TextRange,
  visualLine: VisualLine,
  logicalLineLength: number
): RelativeRange | undefined {
  const line = visualLine.logicalLine
  if (line < range.start.line || line > range.end.line) return undefined

  const selectedStart = line === range.start.line ? range.start.col : 0
  const selectedEnd = line === range.end.line ? range.end.col : logicalLineLength
  const visualStart = visualLine.startCol
  const visualEnd = visualStart + visualLine.length
  const start = Math.max(selectedStart, visualStart)
  const end = Math.min(selectedEnd, visualEnd)
  if (start >= end) return undefined

  return { start: start - visualStart, end: end - visualStart }
}

export function styleTextRange(text: string, range: RelativeRange, style: (selected: string) => string): string {
  if (range.start >= range.end) return text

  const parts: [string, string, string] = ['', '', '']
  let textOffset = 0
  let index = 0
  while (index < text.length) {
    const controlEnd = controlSequenceEnd(text, index)
    if (controlEnd !== undefined) {
      parts[partIndex(textOffset, range)] += text.slice(index, controlEnd)
      index = controlEnd
      continue
    }

    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const value = String.fromCodePoint(codePoint)
    parts[partIndex(textOffset, range)] += value
    textOffset += value.length
    index += value.length
  }

  return `${parts[0]}${styleAcrossResets(parts[1], style)}${parts[2]}`
}

function styleAcrossResets(text: string, style: (selected: string) => string): string {
  return text
    .split(/(\x1b\[(?:0)?m)/)
    .map((part) => (/^\x1b\[(?:0)?m$/.test(part) || part.length === 0 ? part : style(part)))
    .join('')
}

function partIndex(offset: number, range: RelativeRange): 0 | 1 | 2 {
  if (offset < range.start) return 0
  if (offset < range.end) return 1
  return 2
}

function controlSequenceEnd(text: string, index: number): number | undefined {
  if (text[index] !== '\x1b') return undefined
  const kind = text[index + 1]
  if (!kind) return index + 1

  if (kind === '[') {
    let cursor = index + 2
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor)
      cursor++
      if (code >= 0x40 && code <= 0x7e) return cursor
    }
    return text.length
  }

  if (kind === ']' || kind === '_' || kind === 'P' || kind === '^' || kind === 'X') {
    let cursor = index + 2
    while (cursor < text.length) {
      if (text[cursor] === '\x07') return cursor + 1
      if (text[cursor] === '\x1b' && text[cursor + 1] === '\\') return cursor + 2
      cursor++
    }
    return text.length
  }

  return Math.min(text.length, index + 2)
}
