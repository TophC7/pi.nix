import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { hatchAnimation, renderCard } from './card.ts'
import { inferSummaryReaction, reactionFromState, storeReaction } from './reactions.ts'
import { XP_REWARDS, levelBar, levelFromXp } from './leveling.ts'
import { generateBio } from './personality.ts'
import { roll, seededIndex } from './rng.ts'
import { sanitizeMemory, sanitizeName } from './sanitize.ts'
import { SPECIES_LIST, calculateMood, generateName, getReaction, isSpecies, renderSprite, type Mood } from './species.ts'
import { STAT_NAMES, type Companion, type StatName } from './types.ts'
import { renderMarkdownBubble, renderSpeechBubble } from './bubble.ts'

export interface CompanionRow {
  readonly id: string
  readonly name: string
  readonly species: string
  readonly level: number | null
  readonly xp: number | null
  readonly mood: string | null
  readonly personality_bio: string | null
  readonly user_id: string | null
  readonly stat_debugging: number | null
  readonly stat_patience: number | null
  readonly stat_chaos: number | null
  readonly stat_wisdom: number | null
  readonly stat_snark: number | null
  readonly stat_points_available: number | null
  readonly observer_mode: string | null
  readonly guard_mode: number | null
  readonly created_at: string | null
}

export interface HatchOptions {
  readonly name?: string
  readonly species?: string
  readonly userId?: string
  readonly replaceExisting?: boolean
}

export interface HatchResult {
  readonly companion: Companion
  readonly card: string
  readonly animation: string
  readonly reaction: string
}

export interface XpResult {
  readonly xpGained: number
  readonly newXp: number
  readonly newLevel: number
  readonly leveledUp: boolean
  readonly levelInfo: string
}

export interface PetResult {
  readonly companion: Companion
  readonly xp: XpResult
  readonly bubble: string
  readonly xpAwarded: boolean
}

export interface MemoryResult {
  readonly id: string
  readonly companionId: string
  readonly content: string
  readonly importance: number
}

export type ForgetScope = 'memories' | 'progress' | 'all'
export type VoiceMode = 'backseat' | 'skillcoach' | 'both'

export interface ObserveResult {
  readonly companion: Companion
  readonly xp: XpResult
  readonly summary: string
  readonly mode: VoiceMode
  readonly reaction: string
  readonly bubble: string
}

const VOICE_MODES = ['backseat', 'skillcoach', 'both'] as const

const STAT_COLUMNS: Record<StatName, keyof CompanionRow> = {
  DEBUGGING: 'stat_debugging',
  PATIENCE: 'stat_patience',
  CHAOS: 'stat_chaos',
  WISDOM: 'stat_wisdom',
  SNARK: 'stat_snark'
}

const petReactions: Record<string, readonly string[]> = {
  'Void Cat': ['*purrs reluctantly*', '*allows exactly three seconds of petting*', '*pretends not to enjoy it*'],
  'Rust Hound': ['*tail compiles successfully*', '*leans into the scritches*'],
  'Data Drake': ['*hoards this affection carefully*', '*chirps in packet-sized sparks*'],
  'Log Golem': ['*rumbles warmly*', '*adds one happy log entry*'],
  'Cache Crow': ['*caws and hides a shiny feeling*', '*preens with suspicious pride*'],
  'Shell Turtle': ['*accepts pets at a safe pace*', '*slow blink of approval*'],
  Duck: ['*happy little paddle*', '*quacks into the sleeve*'],
  Goose: ['*permits this. barely.*', 'HONK. acceptable.'],
  Blob: ['*squishes approvingly*', '*wobbles into the hand*'],
  Octopus: ['*delegates one arm to affection*', '*all eight arms approve*'],
  Owl: ['*blinks with scholarly tolerance*', '*feathers settle neatly*'],
  Penguin: ['*tiny flipper pat accepted*', '*slides closer*'],
  Snail: ['*extends one polite eyestalk*', '*slowly appreciates this*'],
  Ghost: ['*your hand passes through. still counts.*', '*flickers happily*'],
  Axolotl: ['*gills wiggle brightly*', '*smiles in amphibian*'],
  Capybara: ['*unbothered. pleased.*', '*settles harder*'],
  Cactus: ['*careful side pat only*', '*tiny flower approves*'],
  Robot: ['AFFECTION INPUT ACCEPTED.', '*fans spin softly*'],
  Rabbit: ['*nose twitch escalation*', '*tiny hop of approval*'],
  Mushroom: ['*cap wiggles gently*', '*absorbs good vibes*'],
  Chonk: ['*maximum purr density*', '*leans with structural importance*']
}

export function getCompanion(db: Database, userIdOverride?: string): Companion | null {
  return loadCompanion(db, getPrimaryCompanionRow(db), userIdOverride)
}

export function getRequiredCompanion(db: Database, userIdOverride?: string): Companion {
  const companion = getCompanion(db, userIdOverride)
  if (!companion) throw new Error('Hatch a companion first')
  return companion
}

export function hatchCompanion(db: Database, options: HatchOptions = {}): HatchResult {
  const existing = getPrimaryCompanionRow(db)
  if (existing && !options.replaceExisting) throw new Error('A companion is already hatched')
  if (existing) deleteCompanionData(db, existing.id)

  const id = randomUUID()
  const explicitUserId = options.userId?.trim() || undefined
  const userId = explicitUserId ?? `local:${id}`
  const rolled = roll(userId, SPECIES_LIST)
  const finalSpecies = isSpecies(options.species) ? options.species : rolled.bones.species
  const bones = { ...rolled.bones, species: finalSpecies }
  const name = sanitizeName(options.name) || generateName(finalSpecies, explicitUserId)
  const personalityBio = generateBio(bones)

  db.query(`
    INSERT INTO companions (
      id, name, species, user_id, personality_bio,
      stat_debugging, stat_patience, stat_chaos, stat_wisdom, stat_snark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    finalSpecies,
    userId,
    personalityBio,
    bones.stats.DEBUGGING,
    bones.stats.PATIENCE,
    bones.stats.CHAOS,
    bones.stats.WISDOM,
    bones.stats.SNARK
  )

  const companion = loadCompanion(db, getPrimaryCompanionRow(db), userId)!
  const card = renderCard(companion)
  return {
    companion,
    card,
    animation: hatchAnimation(companion),
    reaction: getReaction(companion.species, 'hatch', 'happy')
  }
}

export function renderCompanionCard(db: Database, userIdOverride?: string): string | null {
  const companion = getCompanion(db, userIdOverride)
  return companion ? renderCard(companion) : null
}

export function rememberCompanion(db: Database, content: string, importance = 1): MemoryResult {
  const companion = getRequiredCompanion(db)
  const cleanContent = sanitizeMemory(content)
  if (!cleanContent) throw new Error('Memory content is empty')

  const id = randomUUID()
  const boundedImportance = Math.max(1, Math.min(5, Math.round(importance)))
  db.query('INSERT INTO memories (id, companion_id, content, importance, tag) VALUES (?, ?, ?, ?, ?)')
    .run(id, companion.id, cleanContent, boundedImportance, 'raw')

  return { id, companionId: companion.id, content: cleanContent, importance: boundedImportance }
}

export function petCompanion(db: Database): PetResult {
  const row = getPrimaryCompanionRow(db)
  if (!row) throw new Error('Hatch a companion first')

  const xpAwarded = canAwardPetXp(db, row.id)
  const xp = xpAwarded ? awardXp(db, row.id, 'pet') : currentXpResult(row)
  const companion = xpAwarded ? refreshMood(db, row.id, xp.leveledUp) : loadCompanion(db, row)!
  const art = renderSprite(companion)
  const hearts = ['   ♥    ♥   ', '  ♥  ♥   ♥  ', ' ♥   ♥  ♥   ']
  const reactions = petReactions[companion.species] ?? ['*accepts the attention with quiet dignity*']
  const reaction = reactions[seededIndex(`${companion.id}:${companion.xp}`, 'pet', reactions.length)]!

  storeReaction(db, companion, reactionFromState('pet', 'happy', reaction, 8_000))

  return {
    companion,
    xp,
    xpAwarded,
    bubble: renderMarkdownBubble(reaction, hearts.concat(art), companion.name)
  }
}

export function observeCompanion(db: Database, summary: string, mode?: string): ObserveResult {
  const row = getPrimaryCompanionRow(db)
  if (!row) throw new Error('Hatch a companion first')

  const cleanSummary = sanitizeMemory(summary)
  if (!cleanSummary) throw new Error('Observation summary is empty')

  const xp = awardXp(db, row.id, 'observe')
  const companion = refreshMood(db, row.id, xp.leveledUp)
  const voiceMode = isVoiceMode(mode) ? mode : isVoiceMode(row.observer_mode) ? row.observer_mode : 'both'
  const baseReaction = getReaction(companion.species, 'xp', toMood(companion.mood), `${cleanSummary}:${companion.xp}`)
  const reaction = xp.leveledUp
    ? `✨ ${companion.name} leveled up to ${xp.newLevel}! ${baseReaction}`
    : baseReaction
  storeReaction(
    db,
    companion,
    xp.leveledUp
      ? reactionFromState('level-up', 'excited', reaction, 15_000)
      : inferSummaryReaction(cleanSummary, reaction, 10_000)
  )

  return {
    companion,
    xp,
    summary: cleanSummary,
    mode: voiceMode,
    reaction,
    bubble: renderSpeechBubble(reaction, renderSprite(companion), companion.name, 34)
  }
}

export function setVoiceMode(db: Database, mode: VoiceMode): Companion {
  const row = getPrimaryCompanionRow(db)
  if (!row) throw new Error('Hatch a companion first')
  db.query('UPDATE companions SET observer_mode = ? WHERE id = ?').run(mode, row.id)
  return getRequiredCompanion(db)
}

export function muteCompanion(db: Database): Companion {
  const row = getPrimaryCompanionRow(db)
  if (!row) throw new Error('Hatch a companion first')
  db.query("UPDATE companions SET mood = 'muted' WHERE id = ?").run(row.id)
  return getRequiredCompanion(db)
}

export function unmuteCompanion(db: Database): Companion {
  const row = getPrimaryCompanionRow(db)
  if (!row) throw new Error('Hatch a companion first')
  db.query("UPDATE companions SET mood = 'happy' WHERE id = ?").run(row.id)
  return getRequiredCompanion(db)
}

export function isVoiceMode(value: unknown): value is VoiceMode {
  return typeof value === 'string' && (VOICE_MODES as readonly string[]).includes(value)
}

export function respawnCompanion(db: Database): Companion | null {
  const row = getPrimaryCompanionRow(db)
  if (!row) return null
  const companion = loadCompanion(db, row)
  deleteCompanionData(db, row.id)
  return companion
}

export function forgetCompanionData(db: Database, scope: ForgetScope = 'memories'): number {
  const row = getPrimaryCompanionRow(db)
  if (!row) return 0

  if (scope === 'memories') {
    const result = db.query('DELETE FROM memories WHERE companion_id = ?').run(row.id)
    return result.changes
  }

  if (scope === 'progress') {
    const deletedEvents = db.query('DELETE FROM xp_events WHERE companion_id = ?').run(row.id).changes
    const deletedEvolution = db.query('DELETE FROM evolution_history WHERE companion_id = ?').run(row.id).changes
    db.query("UPDATE companions SET xp = 0, level = 1, mood = 'happy', stat_points_available = 0 WHERE id = ?").run(row.id)
    return deletedEvents + deletedEvolution
  }

  deleteCompanionData(db, row.id)
  return 1
}

export function loadCompanion(db: Database, row: CompanionRow | null, userIdOverride?: string): Companion | null {
  if (!row) return null

  const userId = userIdOverride || row.user_id || `local:${row.id}`
  const bones = roll(userId, SPECIES_LIST).bones
  const xp = row.xp ?? 0
  const derivedLevel = levelFromXp(xp)
  const stats = Object.fromEntries(
    STAT_NAMES.map((name) => [name, row[STAT_COLUMNS[name]] ?? bones.stats[name]])
  ) as Record<StatName, number>

  if (row.level !== derivedLevel) {
    db.query('UPDATE companions SET level = ? WHERE id = ?').run(derivedLevel, row.id)
  }

  return {
    ...bones,
    id: row.id,
    stats,
    species: row.species,
    name: row.name,
    personalityBio: row.personality_bio ?? '',
    level: derivedLevel,
    xp,
    mood: row.mood ?? 'happy',
    availablePoints: row.stat_points_available ?? 0,
    hatchedAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    observerMode: row.observer_mode ?? 'both',
    guardMode: row.guard_mode === 1
  }
}

export function awardXp(db: Database, companionId: string, eventType: string): XpResult {
  const xpGained = XP_REWARDS[eventType] ?? 1
  const eventId = randomUUID()
  db.query('INSERT INTO xp_events (id, companion_id, event_type, xp_gained) VALUES (?, ?, ?, ?)')
    .run(eventId, companionId, eventType, xpGained)

  const row = db.query('SELECT xp, level FROM companions WHERE id = ?').get(companionId) as { xp?: number; level?: number } | null
  const newXp = (row?.xp ?? 0) + xpGained
  const newLevel = levelFromXp(newXp)
  const leveledUp = newLevel > (row?.level ?? 1)
  db.query('UPDATE companions SET xp = ?, level = ? WHERE id = ?').run(newXp, newLevel, companionId)

  return { xpGained, newXp, newLevel, leveledUp, levelInfo: levelBar(newXp) }
}

function canAwardPetXp(db: Database, companionId: string): boolean {
  const row = db.query("SELECT 1 FROM xp_events WHERE companion_id = ? AND event_type = 'pet' AND created_at > datetime('now', '-1 hour') LIMIT 1")
    .get(companionId) as Record<string, unknown> | null
  return row === null
}

function currentXpResult(row: CompanionRow): XpResult {
  const newXp = row.xp ?? 0
  const newLevel = levelFromXp(newXp)
  return { xpGained: 0, newXp, newLevel, leveledUp: false, levelInfo: levelBar(newXp) }
}

export function recalculateMood(db: Database, companionId: string, leveledUp = false): string {
  if (leveledUp) return 'happy'
  const xpCount = db.query("SELECT count(*) AS count FROM xp_events WHERE companion_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(companionId) as { count?: number } | null
  const memoryCount = db.query("SELECT count(*) AS count FROM memories WHERE companion_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(companionId) as { count?: number } | null

  return calculateMood(new Array(xpCount?.count ?? 0), memoryCount?.count ?? 0)
}

export function getPrimaryCompanionRow(db: Database): CompanionRow | null {
  return db.query('SELECT * FROM companions ORDER BY created_at LIMIT 1').get() as CompanionRow | null
}

function refreshMood(db: Database, companionId: string, leveledUp: boolean): Companion {
  const mood = recalculateMood(db, companionId, leveledUp)
  db.query('UPDATE companions SET mood = ? WHERE id = ?').run(mood, companionId)
  return getRequiredCompanion(db)
}

function toMood(value: string): Mood {
  if (value === 'happy' || value === 'content' || value === 'neutral' || value === 'curious' || value === 'grumpy' || value === 'exhausted') return value
  return 'neutral'
}

function deleteCompanionData(db: Database, companionId: string): void {
  db.query('DELETE FROM reactions WHERE companion_id = ?').run(companionId)
  db.query('DELETE FROM sessions WHERE companion_id = ?').run(companionId)
  db.query('DELETE FROM evolution_history WHERE companion_id = ?').run(companionId)
  db.query('DELETE FROM xp_events WHERE companion_id = ?').run(companionId)
  db.query('DELETE FROM memories WHERE companion_id = ?').run(companionId)
  db.query('DELETE FROM companions WHERE id = ?').run(companionId)
}
