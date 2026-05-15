import { getBuddyDatabase } from './db/index.ts'
import {
  forgetCompanionData,
  getCompanion,
  hatchCompanion,
  isVoiceMode,
  muteCompanion,
  observeCompanion,
  petCompanion,
  rememberCompanion,
  renderCompanionCard,
  respawnCompanion,
  setVoiceMode,
  unmuteCompanion,
  type ForgetScope,
  type VoiceMode
} from './core/index.ts'
import {
  formatModeResponse,
  getReasoningStatus,
  parseGuardFlag,
  purgeReasoning,
  runGuardPipeline,
  setGuardMode,
  type PurgeScope
} from './reasoning/index.ts'

export interface BuddyActionResult {
  readonly text: string
  readonly details?: unknown
  readonly isError?: boolean
}

export interface BuddyHatchInput { readonly name?: string; readonly species?: string; readonly user_id?: string }
export interface BuddyRememberInput { readonly content: string; readonly importance?: number }
export interface BuddyObserveInput { readonly summary: string; readonly mode?: string; readonly claims?: unknown; readonly edges?: unknown; readonly cwd?: string }
export interface BuddyModeInput { readonly mode?: string; readonly guard?: boolean | string }
export interface BuddyForgetInput { readonly scope?: string }
export interface BuddyReasoningStatusInput { readonly cwd?: string }
export interface BuddyReasoningPurgeInput { readonly scope?: string; readonly session_id?: string }

export function buddyHatch(input: BuddyHatchInput = {}): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const result = hatchCompanion(db, { name: input.name, species: input.species, userId: input.user_id })
    return { text: result.animation + '\n\n' + result.reaction, details: { companion: result.companion, card: result.card, animation: result.animation } }
  })
}

export function buddyStatus(): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const companion = getCompanion(db)
    if (!companion) return hatchFirst('No companion hatched yet. Use buddy_hatch to start.')
    return { text: renderCompanionCard(db) ?? 'No companion hatched yet. Use buddy_hatch to start.', details: { companion } }
  })
}

export function buddyRemember(input: BuddyRememberInput): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const memory = rememberCompanion(db, input.content, input.importance)
    return { text: 'Memory stored.', details: memory }
  })
}

export function buddyRespawn(): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const companion = respawnCompanion(db)
    if (!companion) return hatchFirst('No companion to release. Use buddy_hatch to get started.')
    return { text: companion.name + ' the ' + companion.species + ' was released. Use buddy_hatch when ready for a new companion.', details: { companion } }
  })
}

export function buddyObserve(input: BuddyObserveInput): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const before = getCompanion(db)
    const result = observeCompanion(db, input.summary, input.mode)
    let guardDetails: unknown = undefined
    let guardText = ''
    if (before?.guardMode) {
      try {
        const guard = runGuardPipeline(db, { companionId: result.companion.id, cwd: input.cwd, claims: input.claims, edges: input.edges })
        guardDetails = {
          sessionId: guard.sessionId,
          workspace: guard.resolvedRoot.path,
          workspaceSource: guard.resolvedRoot.source,
          writeResult: guard.writeResult,
          finding: guard.finding,
          detectorMs: guard.detectorMs,
          budgetExceeded: guard.budgetExceeded,
          suppression: guard.suppression,
          extractionInstruction: guard.extractionInstruction
        }
        if (guard.finding) guardText = '\n\nGuard note: ' + guard.finding.type + ' — ' + guard.finding.claim_text
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        guardDetails = { fallback: true, error: message }
        guardText = '\n\nGuard note: pipeline unavailable — ' + message
      }
    }

    return {
      text: result.bubble + guardText,
      details: {
        companion: result.companion,
        mode: result.mode,
        summary: result.summary,
        reaction: result.reaction,
        xpGained: result.xp.xpGained,
        levelInfo: result.xp.levelInfo,
        guardMode: before?.guardMode === true,
        guard: guardDetails,
        ...(result.xp.leveledUp ? { levelUp: result.companion.name + ' reached level ' + result.xp.newLevel + '.' } : {})
      }
    }
  })
}

export function buddyPet(): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const result = petCompanion(db)
    return { text: result.bubble, details: { companion: result.companion, xpGained: result.xp.xpGained, levelInfo: result.xp.levelInfo } }
  })
}

export function buddyMute(): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const companion = muteCompanion(db)
    return { text: companion.name + ' has been muted. Use buddy_unmute to bring it back.', details: { companion } }
  })
}

export function buddyUnmute(): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const companion = unmuteCompanion(db)
    return { text: companion.name + ' is back.', details: { companion } }
  })
}

export function buddyMode(input: BuddyModeInput = {}): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    let companion = getCompanion(db)
    if (!companion) return hatchFirst('No companion yet. Use buddy_hatch first.')
    const guard = parseGuardFlag(input.guard)

    if (input.mode !== undefined) {
      if (!isVoiceMode(input.mode)) return { text: 'Unknown Buddy voice mode. Use backseat, skillcoach, or both.', isError: true, details: { mode: input.mode } }
      companion = setVoiceMode(db, input.mode)
    }
    if (guard !== undefined) companion = setGuardMode(db, guard)
    return { text: formatModeResponse(companion), details: { mode: companion.observerMode, guardMode: companion.guardMode } }
  })
}

export function buddyForget(input: BuddyForgetInput = {}): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const scope = parseForgetScope(input.scope)
    const changed = forgetCompanionData(db, scope)
    if (changed === 0) return hatchFirst('Nothing to forget. Hatch a companion first.')
    return { text: 'Buddy forget complete for scope: ' + scope + '.', details: { scope, changed } }
  })
}

export function buddyReasoningStatus(input: BuddyReasoningStatusInput = {}): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const companion = getCompanion(db)
    if (!companion) return hatchFirst('Hatch a companion first.')
    const status = getReasoningStatus(db, companion.id, companion.guardMode, input.cwd)
    return {
      text: 'Guard mode: ' + (status.guardMode ? 'on' : 'off') + '. Session ' + status.sessionId + ': ' + status.claims + ' claims, ' + status.edges + ' edges, ' + status.findings + ' findings.',
      details: status
    }
  })
}

export function buddyReasoningPurge(input: BuddyReasoningPurgeInput = {}): BuddyActionResult {
  return capture(() => {
    const { db } = getBuddyDatabase()
    const scope = parseReasoningScope(input.scope)
    const companion = getCompanion(db)
    const sessionId = scope === 'session' ? input.session_id ?? (companion ? getReasoningStatus(db, companion.id, companion.guardMode).sessionId : undefined) : undefined
    if (scope === 'session' && !sessionId) return hatchFirst('Hatch a companion first or pass session_id to purge reasoning session state.')
    const result = purgeReasoning(db, scope, sessionId)
    return { text: 'Buddy reasoning purge complete: ' + result.claims + ' claims, ' + result.edges + ' edges, ' + result.findings + ' findings.', details: { scope, sessionId, ...result } }
  })
}

export function voiceModes(): readonly VoiceMode[] { return ['backseat', 'skillcoach', 'both'] }

function parseForgetScope(scope: string | undefined): ForgetScope {
  if (scope === 'progress' || scope === 'all') return scope
  return 'memories'
}

function parseReasoningScope(scope: string | undefined): PurgeScope {
  return scope === 'all' ? 'all' : 'session'
}

function hatchFirst(text: string): BuddyActionResult { return { text, isError: true } }

function capture(run: () => BuddyActionResult): BuddyActionResult {
  try { return run() } catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true } }
}

