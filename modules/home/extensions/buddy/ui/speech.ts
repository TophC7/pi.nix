import { visibleWidth } from '@mariozechner/pi-tui'
import { fitLine, padLine, publishWidget } from '@pi/lib/ui'
import type { BuddyActionResult } from '../actions.ts'
import { wrapText } from './dossier.ts'

const OWNER = 'buddy'
const SPEECH_WIDGET_ID = 'buddy:speech'
const SPEECH_TTL_MS = 15_000
const MAX_BUBBLE_WIDTH = 64

export function publishBuddySpeech(result: BuddyActionResult): void {
  if (result.isError) return
  const speech = speechText(result)
  if (!speech) return
  publishWidget({
    id: SPEECH_WIDGET_ID,
    owner: OWNER,
    placement: 'inputRightTop',
    priority: 'critical',
    order: -10,
    ttlMs: SPEECH_TTL_MS,
    schedule: { animateEveryMs: 600 },
    content: (context) => renderSpeechBubble(speech, context.width)
  })
}

function speechText(result: BuddyActionResult): string {
  const details = result.details as { reaction?: unknown; levelUp?: unknown } | undefined
  const lines = [details?.levelUp, details?.reaction]
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
  if (lines.length > 0) return lines.join('\n')
  return ''
}

function renderSpeechBubble(text: string, width: number): readonly string[] {
  if (width < 5) return []
  const contentWidth = Math.min(MAX_BUBBLE_WIDTH, width - 2)
  const wrapWidth = Math.max(1, contentWidth - 2)
  const rawLines = text.split('\n').flatMap((line) => wrapText(line, wrapWidth))
  const innerWidth = Math.max(...rawLines.map((line) => visibleWidth(line)), 1)
  const top = `╭${'─'.repeat(innerWidth + 2)}╮`
  const bottom = `╰${'─'.repeat(innerWidth + 2)}╯`
  return [top, ...rawLines.map((line) => `│ ${padLine(line, innerWidth)} │`), bottom].map((line) => fitLine(line, width))
}
