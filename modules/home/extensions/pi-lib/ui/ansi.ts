import { visibleWidth } from '@mariozechner/pi-tui'

// ABOUT: Low-level ANSI / control-sequence string surgery used across the UI
// layer. stripControls is intentionally regex-only (no pi-tui dependency) and
// scrubs OSC + CSI + control whitespace so legacy status text is safe to lay
// out in shared rendering. truncLine is ANSI-aware truncation that preserves
// active styles through the cut; pi-tui's truncateToWidth drops styles before
// the ellipsis and can bleed background colors.

const ANSI_RESET = '\x1b[0m'
const ANSI_PATTERN = /\x1b\[[0-9;]*m/y
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function stripControls(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
}

export function truncLine(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text
  const targetWidth = Math.max(0, maxWidth - 1)
  let result = ''
  let currentWidth = 0
  let activeStyles: string[] = []
  let i = 0
  while (i < text.length) {
    const ansiCode = ansiAt(text, i)
    if (ansiCode) {
      result += ansiCode
      if (ansiCode === ANSI_RESET || ansiCode === '\x1b[m') activeStyles = []
      else activeStyles.push(ansiCode)
      i += ansiCode.length
      continue
    }

    const nextAnsi = text.indexOf('\x1b[', i)
    const end = nextAnsi === -1 ? text.length : Math.max(i + 1, nextAnsi)
    for (const seg of segmenter.segment(text.slice(i, end))) {
      const w = visibleWidth(seg.segment)
      if (currentWidth + w > targetWidth) return finishTruncated(result, activeStyles)
      result += seg.segment
      currentWidth += w
    }
    i = end
  }
  return finishTruncated(result, activeStyles)
}

function ansiAt(text: string, index: number): string | undefined {
  ANSI_PATTERN.lastIndex = index
  return ANSI_PATTERN.exec(text)?.[0]
}

function finishTruncated(result: string, activeStyles: readonly string[]): string {
  return activeStyles.length > 0 ? `${result}${activeStyles.join('')}…${ANSI_RESET}` : `${result}…`
}
