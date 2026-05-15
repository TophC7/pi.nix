import { SPRITE_BODIES } from './species.ts'
import type { Companion } from './types.ts'
import type { StoredReaction } from './reactions.ts'

export type AnimationState =
  | 'idle'
  | 'happy'
  | 'content'
  | 'curious'
  | 'grumpy'
  | 'muted'
  | 'exhausted'
  | 'reaction_excited'
  | 'reaction_impressed'
  | 'reaction_concerned'
  | 'reaction_other'

export interface FrameRef {
  readonly frame: number
  readonly blink?: boolean
}

export interface AnimationProfile {
  readonly idle: readonly FrameRef[]
  readonly happy?: readonly FrameRef[]
  readonly content?: readonly FrameRef[]
  readonly curious?: readonly FrameRef[]
  readonly grumpy?: readonly FrameRef[]
  readonly muted?: readonly FrameRef[]
  readonly exhausted?: readonly FrameRef[]
  readonly reactionExcited?: readonly FrameRef[]
  readonly reactionImpressed?: readonly FrameRef[]
  readonly reactionConcerned?: readonly FrameRef[]
  readonly reactionOther?: readonly FrameRef[]
  readonly dwellMs?: number
}

export const DEFAULT_DWELL_MS = 500

const SPECIES_OVERRIDES: Partial<Record<string, Partial<AnimationProfile>>> = {
  Snail: { dwellMs: 800 },
  'Shell Turtle': { dwellMs: 700 },
  Capybara: { dwellMs: 700 },
  'Cache Crow': { dwellMs: 400 },
  Duck: { dwellMs: 400 },
  Goose: { dwellMs: 400 },
  Penguin: { dwellMs: 400 },
  Rabbit: { dwellMs: 400 }
}

const profileCache = new Map<string, AnimationProfile>()

export function getAnimationProfile(species: string): AnimationProfile {
  const cached = profileCache.get(species)
  if (cached) return cached

  const frameCount = Math.max(1, SPRITE_BODIES[species]?.length ?? 1)
  const idle: FrameRef = { frame: 0 }
  const syntheticFrameCount = Math.max(frameCount, 4)
  const blink: FrameRef = { frame: frameCount > 1 ? 1 : 0, blink: true }
  const action1: FrameRef = { frame: 2 }
  const action2: FrameRef = { frame: 3 }
  const actionFrames = Array.from({ length: syntheticFrameCount }, (_, frame) => ({ frame }))

  const base: AnimationProfile = {
    idle: [idle, idle, idle, idle, blink, idle, idle, idle, action1, idle, idle, action2],
    happy: [idle, action1, idle, action2, idle, blink, idle, action1],
    content: [idle, idle, action1, idle, blink, idle, action2, idle],
    curious: [idle, action2, idle, blink, idle, action1],
    grumpy: [idle, idle, idle, blink, idle, idle],
    muted: [idle, idle, idle, idle],
    exhausted: [idle, idle, blink, idle, idle],
    reactionExcited: actionFrames,
    reactionImpressed: actionFrames,
    reactionConcerned: [idle, blink, idle, blink],
    reactionOther: frameCount > 1 ? actionFrames.slice(1) : [blink, idle],
    dwellMs: DEFAULT_DWELL_MS,
    ...SPECIES_OVERRIDES[species]
  }

  profileCache.set(species, base)
  return base
}

export function getAnimationState(companion: Companion, reaction: StoredReaction | null, now = Date.now()): AnimationState {
  if (reaction && reaction.expiresAt > now) {
    switch (reaction.state) {
      case 'excited':
        return 'reaction_excited'
      case 'impressed':
        return 'reaction_impressed'
      case 'concerned':
        return 'reaction_concerned'
      default:
        return 'reaction_other'
    }
  }

  switch (companion.mood) {
    case 'happy':
      return 'happy'
    case 'content':
      return 'content'
    case 'curious':
      return 'curious'
    case 'grumpy':
      return 'grumpy'
    case 'muted':
      return 'muted'
    case 'exhausted':
      return 'exhausted'
    default:
      return 'idle'
  }
}

export function pickFrame(profile: AnimationProfile, state: AnimationState, tickOrNowMs: number): FrameRef {
  const dwellMs = profile.dwellMs ?? DEFAULT_DWELL_MS
  const tick = tickOrNowMs < 10_000 ? Math.floor(tickOrNowMs) : Math.floor(tickOrNowMs / dwellMs)
  const sequence = sequenceFor(profile, state)
  return sequence[tick % sequence.length] ?? { frame: 0 }
}

function sequenceFor(profile: AnimationProfile, state: AnimationState): readonly FrameRef[] {
  switch (state) {
    case 'happy':
      return profile.happy ?? profile.idle
    case 'content':
      return profile.content ?? profile.happy ?? profile.idle
    case 'curious':
      return profile.curious ?? profile.idle
    case 'grumpy':
      return profile.grumpy ?? profile.idle
    case 'muted':
      return profile.muted ?? profile.grumpy ?? profile.idle
    case 'exhausted':
      return profile.exhausted ?? profile.grumpy ?? profile.idle
    case 'reaction_excited':
      return profile.reactionExcited ?? profile.idle
    case 'reaction_impressed':
      return profile.reactionImpressed ?? profile.reactionExcited ?? profile.idle
    case 'reaction_concerned':
      return profile.reactionConcerned ?? profile.idle
    case 'reaction_other':
      return profile.reactionOther ?? profile.idle
    default:
      return profile.idle
  }
}
