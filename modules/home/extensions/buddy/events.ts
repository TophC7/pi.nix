import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { getCompanion } from './core/companion.ts'
import { getActiveReaction, inferPromptReaction, inferToolReaction, storeReaction } from './core/reactions.ts'
import type { Companion } from './core/types.ts'
import { getBuddyDatabase } from './db/index.ts'
import { buildBuddyContext } from './prompts.ts'
import { refreshBuddyRenderState } from './ui/render.ts'

const STATUS_KEY = 'buddy'
let activePi: ExtensionAPI | undefined
let lastStatusText: string | undefined

export function refreshBuddyStatus(pi: ExtensionAPI = activePi as ExtensionAPI, companion?: Companion | null): void {
  if (!pi) return
  const db = maybeBuddyDatabase()
  const current = companion === undefined ? (db ? getCompanion(db) : null) : companion
  refreshBuddyRenderState(current, db && current ? getActiveReaction(db, current.id) : null)

  const setStatus = (pi as { ui?: { setStatus?: (key: string, text: string | undefined) => void } }).ui?.setStatus
  if (typeof setStatus !== 'function') return
  const statusText = current ? current.name : undefined
  if (statusText === lastStatusText) return
  lastStatusText = statusText
  setStatus(STATUS_KEY, statusText)
}

interface BeforeAgentStartEvent {
  readonly prompt?: string
}

interface ToolExecutionEndEvent {
  readonly toolName?: string
  readonly result?: unknown
  readonly isError?: boolean
}

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
      message: {
        customType: 'buddy-context',
        content: buildBuddyContext(companion),
        display: false
      }
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
}

export function getCurrentBuddyReaction() {
  const db = maybeBuddyDatabase()
  if (!db) return null
  const companion = getCompanion(db)
  return companion ? getActiveReaction(db, companion.id) : null
}

function maybeBuddyDatabase() {
  try {
    return getBuddyDatabase().db
  } catch {
    return null
  }
}
