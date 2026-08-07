import type { Context } from '@earendil-works/pi-ai'

// Shared session-state machinery for CLI-backed providers (claude,
// antigravity): persisted-entry restoration, turn-boundary detection,
// canonical message hashing, and digest extension. Prompt construction and the
// provider-specific persisted-state shapes stay with each provider.

export type ContextDigest = {
  contextHash: string
  messageCount: number
}

export type SessionStateBinding<State> = {
  append: (state: State) => void
}

export type SessionStateRuntime<
  State,
  Binding extends SessionStateBinding<State> = SessionStateBinding<State>
> = {
  persisted?: State
  validated?: ContextDigest
  binding?: Binding
}

type ResumableSessionState = { modelId: string } & ContextDigest
type ProviderSessionState = { reset: true } | ResumableSessionState

type SessionAlignment<State extends ResumableSessionState> =
  | { isolated: true; aligned: false; state?: undefined }
  | {
      isolated: false
      aligned: boolean
      historyDigest: ContextDigest
      state?: State
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

/** Validates whether persisted provider state still matches Pi's history. */
export function alignSessionHistory<State extends ProviderSessionState>(
  session: Pick<SessionStateRuntime<State>, 'persisted' | 'validated'>,
  modelId: string,
  history: Context['messages'],
  isolated: boolean,
  digest: (messages: Context['messages']) => ContextDigest
): SessionAlignment<Exclude<State, { reset: true }>> {
  if (isolated) return { isolated: true, aligned: false }

  const persisted = session.persisted
  const state =
    persisted && !('reset' in persisted) ? (persisted as Exclude<State, { reset: true }>) : undefined
  if (!state || state.modelId !== modelId || state.messageCount !== history.length) {
    return { isolated: false, aligned: false, historyDigest: digest(history) }
  }

  const cached = session.validated
  if (cached?.messageCount === state.messageCount && cached.contextHash === state.contextHash) {
    return { isolated: false, aligned: true, historyDigest: cached, state }
  }

  const historyDigest = digest(history)
  const aligned = historyDigest.contextHash === state.contextHash
  if (aligned) session.validated = historyDigest
  return { isolated: false, aligned, historyDigest, state: aligned ? state : undefined }
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
  const hasher = new Bun.CryptoHasher('sha256')
  for (const message of messages) {
    hasher.update(`${contextHash}\u0000${JSON.stringify(transformMessage(message))}`)
    contextHash = hasher.digest('hex')
  }
  return { contextHash, messageCount: prefix.messageCount + messages.length }
}

/** Extends a validated history digest and publishes provider-specific state. */
export function persistSessionState<State>(
  session: SessionStateRuntime<State>,
  prefix: ContextDigest,
  messages: Context['messages'],
  createState: (digest: ContextDigest) => State
): State {
  const digest = extendContextDigest(prefix, messages)
  const state = createState(digest)
  session.persisted = state
  session.validated = digest
  session.binding?.append(state)
  return state
}

function digestText(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return hasher.digest('hex')
}
