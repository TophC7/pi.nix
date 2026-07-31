import type { Context, UserMessage } from '@earendil-works/pi-ai'
import type { InputContent } from './prompt-stream.js'

export const SESSION_ENTRY_TYPE = 'claude-session'

export type ContextDigest = {
  contextHash: string
  messageCount: number
}

export type PersistedSessionState =
  | { version: 2; reset: true }
  | ({
      version: 2
      claudeSessionId: string
      modelId: string
    } & ContextDigest)

const EMPTY_CONTEXT_HASH = digestText('claude-context-v2')

export function restoredSessionState(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): PersistedSessionState | undefined {
  let latest: unknown
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.type === 'custom' && entry.customType === SESSION_ENTRY_TYPE) {
      latest = entry.data
      break
    }
  }
  return isPersistedState(latest) ? latest : undefined
}

export function priorMessages(
  messages: Context['messages'],
): Context['messages'] {
  return messages.slice(0, currentTurnStart(messages))
}

export function currentPrompt(messages: Context['messages']): InputContent[] {
  const blocks: InputContent[] = []
  for (const message of messages.slice(
    currentTurnStart(messages),
  ) as UserMessage[]) {
    appendUserContent(blocks, message)
  }
  return blocks
}

export function bootstrapPrompt(messages: Context['messages']): InputContent[] {
  const transcript = messages.map(bootstrapMessage)
  const blocks: InputContent[] = [
    {
      type: 'text',
      text:
        'Continue this Pi-managed conversation. The JSON transcript below is authoritative prior context. ' +
        'Do not describe the transcript; respond to its final user turn.\n\n' +
        `<pi_transcript>\n${JSON.stringify(transcript)}\n</pi_transcript>`,
    },
  ]
  const current = messages.slice(currentTurnStart(messages)) as UserMessage[]
  for (const message of current) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type !== 'image') continue
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType,
          data: block.data,
        },
      })
    }
  }
  return blocks
}

export function contextDigest(messages: Context['messages']): ContextDigest {
  return extendContextDigest(
    { contextHash: EMPTY_CONTEXT_HASH, messageCount: 0 },
    messages,
  )
}

export function extendContextDigest(
  prefix: ContextDigest,
  messages: Context['messages'],
): ContextDigest {
  let contextHash = prefix.contextHash
  for (const message of messages) {
    contextHash = digestText(
      `${contextHash}\u0000${JSON.stringify(hashMessage(message))}`,
    )
  }
  return {
    contextHash,
    messageCount: prefix.messageCount + messages.length,
  }
}

function currentTurnStart(messages: Context['messages']): number {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === 'user') start--
  return start
}

function appendUserContent(blocks: InputContent[], message: UserMessage): void {
  if (typeof message.content === 'string') {
    if (message.content) blocks.push({ type: 'text', text: message.content })
    return
  }
  for (const block of message.content) {
    if (block.type === 'text' && block.text)
      blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType,
          data: block.data,
        },
      })
    }
  }
}

function bootstrapMessage(message: unknown): unknown {
  return transform(message, true)
}

function hashMessage(message: unknown): unknown {
  return transform(message, false)
}

function transform(value: unknown, omitImageData: boolean): unknown {
  if (Array.isArray(value))
    return value.map((item) => transform(item, omitImageData))
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (key === 'timestamp' || key === 'usage' || key === 'cost') continue
    if (key === 'data' && source.type === 'image') {
      result.data = omitImageData
        ? '[image data attached separately when current]'
        : `[sha256:${digestText(String(source.data ?? ''))}]`
      continue
    }
    result[key] = transform(source[key], omitImageData)
  }
  return result
}

function digestText(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return hasher.digest('hex')
}

function isPersistedState(value: unknown): value is PersistedSessionState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  if (state.version !== 2) return false
  if (state.reset === true) return true
  return (
    typeof state.claudeSessionId === 'string' &&
    typeof state.modelId === 'string' &&
    typeof state.contextHash === 'string' &&
    Number.isInteger(state.messageCount) &&
    Number(state.messageCount) >= 0
  )
}
