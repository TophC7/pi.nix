function wrapText(text: string, width: number): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }

    let current = ''
    for (const word of words) {
      if (current && current.length + word.length + 1 > width) {
        lines.push(current)
        current = word
      } else {
        current = current ? `${current} ${word}` : word
      }
    }

    if (current) lines.push(current)
  }

  return lines
}

export function renderMarkdownBubble(text: string, artLines: readonly string[], companionName: string): string {
  const artBlock = '```\n' + [...artLines, companionName].join('\n') + '\n```'
  const quotedText = text.split('\n')
    .map((line) => line.trim() ? `> ${line}` : '>')
    .join('\n')

  return `${artBlock}\n\n${quotedText}`
}

export function renderSpeechBubble(
  text: string,
  artLines: readonly string[],
  companionName: string,
  bubbleWidth = 30
): string {
  const innerWidth = bubbleWidth - 4
  const wrapped = wrapText(text, innerWidth)
  const topBorder = '.' + '_'.repeat(bubbleWidth - 2) + '.'
  const bottomBorder = "'" + '_'.repeat(bubbleWidth - 2) + "'"
  const bubbleLines = [
    topBorder,
    ...wrapped.map((line) => `| ${line.padEnd(innerWidth)} |`),
    bottomBorder
  ]
  const height = Math.max(bubbleLines.length, artLines.length + 1)
  const rows: string[] = []

  for (let index = 0; index < height; index++) {
    const bubble = bubbleLines[index] ?? ' '.repeat(bubbleWidth)
    const art = artLines[index] ?? (index === artLines.length ? companionName : '')
    rows.push(`${bubble}  ${art}`)
  }

  return rows.join('\n')
}
