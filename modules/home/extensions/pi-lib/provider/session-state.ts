import type { Context } from '@earendil-works/pi-ai'

// Shared session-state machinery for CLI-backed providers (claude,
// antigravity): persisted-entry restoration, turn-boundary detection,
// canonical message hashing, and digest extension. Prompt construction and the
// provider-specific persisted-state shapes stay with each provider.

export type ContextDigest = {
  contextHash: string
  messageCount: number
}

/**
 * Latest persisted provider entry from a session branch, validated against
 * the common state shape: `{ version, reset: true }` or
 * `{ version, [idKey]: string, modelId, contextHash, messageCount }`.
 */
export function restoredSessionState<State>(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  entryType: string,
  version: number,
  idKey: string
): State | undefined {
  let latest: unknown
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.type === 'custom' && entry.customType === entryType) {
      latest = entry.data
      break
    }
  }
  if (!latest || typeof latest !== 'object') return undefined
  const state = latest as Record<string, unknown>
  if (state.version !== version) return undefined
  if (state.reset === true) return latest as State
  const valid =
    typeof state[idKey] === 'string' &&
    typeof state.modelId === 'string' &&
    typeof state.contextHash === 'string' &&
    Number.isInteger(state.messageCount) &&
    Number(state.messageCount) >= 0
  return valid ? (latest as State) : undefined
}

export function currentTurnStart(messages: Context['messages']): number {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === 'user') start--
  return start
}

export function priorMessages(messages: Context['messages']): Context['messages'] {
  return messages.slice(0, currentTurnStart(messages))
}

/**
 * Normalizes a message for hashing or transcript embedding: drops fields that
 * vary without changing meaning, and never inlines image bytes. Hashing keeps
 * a content digest in place of the bytes; bootstrap transcripts substitute the
 * provider's `imagePlaceholder` text.
 */
export function transformMessage(value: unknown, imagePlaceholder?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => transformMessage(item, imagePlaceholder))
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (key === 'timestamp' || key === 'usage' || key === 'cost') continue
    if (key === 'data' && source.type === 'image') {
      result.data = imagePlaceholder ?? `[sha256:${digestText(String(source.data ?? ''))}]`
      continue
    }
    result[key] = transformMessage(source[key], imagePlaceholder)
  }
  return result
}

/** Digest of `messages`, chained from the provider's version seed. */
export function contextDigest(seed: string, messages: Context['messages']): ContextDigest {
  return extendContextDigest({ contextHash: digestText(seed), messageCount: 0 }, messages)
}

export function extendContextDigest(prefix: ContextDigest, messages: Context['messages']): ContextDigest {
  let contextHash = prefix.contextHash
  for (const message of messages) {
    contextHash = digestText(`${contextHash}\u0000${JSON.stringify(transformMessage(message))}`)
  }
  return { contextHash, messageCount: prefix.messageCount + messages.length }
}

function digestText(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return hasher.digest('hex')
}
