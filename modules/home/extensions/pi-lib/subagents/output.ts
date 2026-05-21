import type { SubagentSlotResult, SubagentTruncation } from './types.ts'
import { buildParentFacingText } from './types.ts'

export const RECENT_OUTPUT_MAX_LINES = 20
export const RECENT_OUTPUT_MAX_BYTES = 16 * 1024
export const TOOL_PREVIEW_MAX_BYTES = 4 * 1024
export const PARENT_RESULT_MAX_BYTES = 50 * 1024

export interface CappedText {
  text: string
  truncation?: SubagentTruncation
}

export function capRecentOutput(previous: string, delta: string): CappedText {
  const combined = previous + delta
  const byLines = tailLines(combined, RECENT_OUTPUT_MAX_LINES)
  const byBytes = tailBytes(byLines.text, RECENT_OUTPUT_MAX_BYTES)
  return {
    text: byBytes.text,
    truncation: combineTruncation(
      byLines.truncation,
      byBytes.truncation,
      'Recent output capped to last 20 lines / 16 KiB.'
    )
  }
}

export function capToolPreview(text: string): CappedText {
  const capped = headBytes(text, TOOL_PREVIEW_MAX_BYTES)
  return {
    text: capped.text,
    truncation: capped.truncation
      ? {
          ...capped.truncation,
          note: 'Tool result preview capped to 4 KiB.'
        }
      : undefined
  }
}

export function buildCappedParentFacingText(slots: readonly SubagentSlotResult[]): CappedText {
  const text = buildParentFacingText(slots)
  const note = aggregateTruncationNote(slots)
  const capped = headBytes(text, PARENT_RESULT_MAX_BYTES, note)
  return {
    text: capped.text,
    truncation: capped.truncation
      ? {
          ...capped.truncation,
          note: 'Parent-facing subagent result capped to 50 KiB.' + (note ? ` ${note}` : '')
        }
      : undefined
  }
}

function aggregateTruncationNote(slots: readonly SubagentSlotResult[]): string {
  const lines: string[] = []
  for (const slot of slots) {
    if (slot.error) lines.push(`[${slot.agent}] failure: ${slot.error}`)
    const fullOutputPath = slot.outputPath ?? slot.output.truncation?.fullOutputPath
    if (fullOutputPath) lines.push(`[${slot.agent}] full output: ${fullOutputPath}`)
  }
  if (lines.length === 0) return ''
  return [`[Truncation metadata preserved]`, ...lines].join('\n')
}

function tailLines(text: string, maxLines: number): CappedText {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text }
  const kept = lines.slice(-maxLines).join('\n')
  return {
    text: kept,
    truncation: {
      truncated: true,
      limitLines: maxLines,
      originalLines: lines.length,
      omittedLines: lines.length - maxLines
    }
  }
}

function tailBytes(text: string, maxBytes: number): CappedText {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text }
  const buffer = Buffer.from(text, 'utf8')
  const kept = buffer
    .subarray(Math.max(0, buffer.length - maxBytes))
    .toString('utf8')
    .replace(/^�+/, '')
  return {
    text: kept,
    truncation: {
      truncated: true,
      limitBytes: maxBytes,
      originalBytes: bytes,
      omittedBytes: Math.max(0, bytes - Buffer.byteLength(kept, 'utf8'))
    }
  }
}

export function headBytes(text: string, maxBytes: number, suffix = ''): CappedText {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text }
  const suffixText = suffix ? `\n\n${suffix}` : ''
  const suffixBytes = Buffer.byteLength(suffixText, 'utf8')
  const budget = Math.max(0, maxBytes - suffixBytes)
  const buffer = Buffer.from(text, 'utf8')
  const kept = buffer.subarray(0, budget).toString('utf8').replace(/�+$/, '')
  return {
    text: `${kept}${suffixText}`,
    truncation: {
      truncated: true,
      limitBytes: maxBytes,
      originalBytes: bytes,
      omittedBytes: Math.max(0, bytes - Buffer.byteLength(kept, 'utf8'))
    }
  }
}

function combineTruncation(
  first: SubagentTruncation | undefined,
  second: SubagentTruncation | undefined,
  note: string
): SubagentTruncation | undefined {
  if (!first && !second) return undefined
  return {
    truncated: true,
    limitBytes: second?.limitBytes ?? first?.limitBytes,
    limitLines: first?.limitLines ?? second?.limitLines,
    originalBytes: second?.originalBytes ?? first?.originalBytes,
    originalLines: first?.originalLines ?? second?.originalLines,
    omittedBytes: second?.omittedBytes ?? first?.omittedBytes,
    omittedLines: first?.omittedLines ?? second?.omittedLines,
    note
  }
}
