import type { Context, UserMessage } from '@earendil-works/pi-ai'
import {
  contextDigest as seededContextDigest,
  currentTurnStart,
  restoredSessionState as validatedSessionState,
  transformMessage,
  type ContextDigest
} from '@pi/lib/provider/session-state'
import type { InputContent } from './prompt-stream.js'

export { extendContextDigest, priorMessages } from '@pi/lib/provider/session-state'
export type { ContextDigest } from '@pi/lib/provider/session-state'

export const SESSION_ENTRY_TYPE = 'claude-session'

export type PersistedSessionState =
  | { version: 2; reset: true }
  | ({
      version: 2
      claudeSessionId: string
      modelId: string
    } & ContextDigest)

const CONTEXT_SEED = 'claude-context-v2'

export function restoredSessionState(
  entries: Array<{ type: string; customType?: string; data?: unknown }>
): PersistedSessionState | undefined {
  return validatedSessionState<PersistedSessionState>(entries, SESSION_ENTRY_TYPE, 2, 'claudeSessionId')
}

export function currentPrompt(messages: Context['messages']): InputContent[] {
  const blocks: InputContent[] = []
  for (const message of messages.slice(currentTurnStart(messages)) as UserMessage[]) {
    appendUserContent(blocks, message)
  }
  return blocks
}

export function bootstrapPrompt(messages: Context['messages']): InputContent[] {
  const transcript = messages.map((message) => transformMessage(message, '[image data attached separately when current]'))
  const blocks: InputContent[] = [
    {
      type: 'text',
      text:
        'Continue this Pi-managed conversation. The JSON transcript below is authoritative prior context. ' +
        'Do not describe the transcript; respond to its final user turn.\n\n' +
        `<pi_transcript>\n${JSON.stringify(transcript)}\n</pi_transcript>`
    }
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
          data: block.data
        }
      })
    }
  }
  return blocks
}

export function contextDigest(messages: Context['messages']): ContextDigest {
  return seededContextDigest(CONTEXT_SEED, messages)
}

function appendUserContent(blocks: InputContent[], message: UserMessage): void {
  if (typeof message.content === 'string') {
    if (message.content) blocks.push({ type: 'text', text: message.content })
    return
  }
  for (const block of message.content) {
    if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType,
          data: block.data
        }
      })
    }
  }
}
