import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getCompanion } from './core/companion.ts'
import {
  getActiveReaction,
  inferPromptReaction,
  inferToolReaction,
  reactionFromState,
  storeReaction
} from './core/reactions.ts'
import type { Companion } from './core/types.ts'
import { getBuddyDatabase } from './db/index.ts'
import { buildBuddyContext } from './prompts.ts'
import { refreshBuddyRenderState } from './ui/render.ts'

let activePi: ExtensionAPI | undefined

export function refreshBuddyStatus(pi: ExtensionAPI = activePi as ExtensionAPI, companion?: Companion | null): void {
  if (!pi) return
  const db = maybeBuddyDatabase()
  const current = companion === undefined ? (db ? getCompanion(db) : null) : companion
  refreshBuddyRenderState(current, db && current ? getActiveReaction(db, current.id) : null)
}

interface BeforeAgentStartEvent {
  readonly prompt?: string
  readonly systemPrompt?: string
}

interface ToolExecutionEndEvent {
  readonly toolName?: string
  readonly result?: unknown
  readonly isError?: boolean
}

interface MessageEndEvent {
  readonly message?: { readonly role?: string; readonly content?: unknown }
}

const COMPLETION_REGEX =
  /\b(?:I(?:'ve| have) (?:implemented|added|created|updated|fixed|refactored|written|deployed|pushed|committed|completed|finished)|(?:all )?tests? (?:pass(?:ed|ing)?|are passing)|(?:the )?(?:fix|change|implementation) is (?:in place|complete|done)|successfully (?:deployed|committed|pushed|built)|(?:build|compilation) (?:succeeded|passed))\b/i
const ONGOING_REGEX =
  /^(?:I'?ll |Let me |I (?:need to|should|will|can)|Looking at|Checking|Reading|I'm (?:going to|working on|looking at))/i
const COMPLETION_REACTIONS = [
  'ooh, new code. looking.',
  'that landed.',
  'progress registered.',
  'task complete.',
  'bits moved.'
] as const

export function registerBuddyEvents(pi: ExtensionAPI): void {
  activePi = pi
  refreshBuddyStatus(pi)

  pi.on('before_agent_start', async (event) => {
    const promptEvent = event as BeforeAgentStartEvent
    const db = maybeBuddyDatabase()
    if (!db) {
      refreshBuddyStatus(pi, null)
      return undefined
    }
    const companion = getCompanion(db)
    refreshBuddyStatus(pi, companion)
    if (!companion) return undefined

    const reaction = inferPromptReaction(companion, promptEvent.prompt ?? '')
    if (reaction) {
      storeReaction(db, companion, reaction)
      refreshBuddyStatus(pi, companion)
    }

    return {
      systemPrompt: `${promptEvent.systemPrompt ?? ''}\n\n${buildBuddyContext(companion)}`
    }
  })

  pi.on('tool_execution_end', async (event) => {
    const toolEvent = event as ToolExecutionEndEvent
    const db = maybeBuddyDatabase()
    if (!db) {
      refreshBuddyStatus(pi, null)
      return undefined
    }
    const companion = getCompanion(db)
    refreshBuddyStatus(pi, companion)
    if (!companion) return undefined

    const reaction = inferToolReaction(toolEvent.toolName ?? 'tool', toolEvent.result, toolEvent.isError)
    if (!reaction) return undefined

    storeReaction(db, companion, reaction)
    refreshBuddyStatus(pi, companion)
    return undefined
  })

  pi.on('message_end', async (event) => {
    const messageEvent = event as MessageEndEvent
    if (messageEvent.message?.role !== 'assistant') return undefined
    const text = assistantText(messageEvent.message.content)
    if (!isCompletionMessage(text)) return undefined

    const db = maybeBuddyDatabase()
    if (!db) {
      refreshBuddyStatus(pi, null)
      return undefined
    }
    const companion = getCompanion(db)
    if (!companion) {
      refreshBuddyStatus(pi, null)
      return undefined
    }

    const reaction = COMPLETION_REACTIONS[Math.floor(Date.now() / 1000) % COMPLETION_REACTIONS.length]!
    storeReaction(db, companion, reactionFromState('assistant:completion', 'excited', reaction, 15_000))
    refreshBuddyStatus(pi, companion)
    return undefined
  })
}

export function getCurrentBuddyReaction() {
  const db = maybeBuddyDatabase()
  if (!db) return null
  const companion = getCompanion(db)
  return companion ? getActiveReaction(db, companion.id) : null
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) =>
      item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : ''
    )
    .join(' ')
}

function isCompletionMessage(text: string): boolean {
  if (!text || text.length < 60) return false
  if (ONGOING_REGEX.test(text)) return false
  return COMPLETION_REGEX.test(text)
}

function maybeBuddyDatabase() {
  try {
    return getBuddyDatabase().db
  } catch {
    return null
  }
}
