import type { Context, UserMessage } from '@earendil-works/pi-ai'
import {
  contextDigest as seededContextDigest,
  currentTurnStart,
  restoredSessionState as validatedSessionState,
  transformMessage,
  type ContextDigest
} from '@pi/lib/provider/session-state'

export { extendContextDigest, priorMessages } from '@pi/lib/provider/session-state'
export type { ContextDigest } from '@pi/lib/provider/session-state'

export const SESSION_ENTRY_TYPE = 'antigravity-session'

export type PersistedSessionState =
  | { version: 1; reset: true }
  | ({ version: 1; conversationId: string; modelId: string } & ContextDigest)

const CONTEXT_SEED = 'antigravity-context-v1'

export function restoredSessionState(
  entries: Array<{ type: string; customType?: string; data?: unknown }>
): PersistedSessionState | undefined {
  return validatedSessionState<PersistedSessionState>(entries, SESSION_ENTRY_TYPE, 1, 'conversationId')
}

/** The current user turn, for an AGY conversation that already holds the history. */
export function currentPrompt(messages: Context['messages']): string {
  return (messages.slice(currentTurnStart(messages)) as UserMessage[]).map(userText).filter(Boolean).join('\n\n')
}

/**
 * A fresh AGY conversation knows nothing, so the whole Pi transcript is handed
 * over as authoritative context. Pi remains the source of truth; the AGY
 * conversation is only an aligned cache of it.
 */
export function bootstrapPrompt(messages: Context['messages']): string {
  const transcript = messages.map((message) => transformMessage(message, '[image omitted]'))
  return (
    'Continue this Pi-managed conversation. The JSON transcript below is authoritative prior context. ' +
    'Do not describe the transcript; respond to its final user turn.\n\n' +
    `<pi_transcript>\n${JSON.stringify(transcript)}\n</pi_transcript>`
  )
}

export function contextDigest(messages: Context['messages']): ContextDigest {
  return seededContextDigest(CONTEXT_SEED, messages)
}

function userText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && Boolean(block.text))
    .map((block) => block.text)
    .join('\n')
}
