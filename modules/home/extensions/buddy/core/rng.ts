import { renderProportionalBar } from '@pi/lib/ui'
import {
  EYES,
  HATS,
  RARITIES,
  RARITY_FLOOR,
  RARITY_WEIGHTS,
  STAT_NAMES,
  type CompanionBones,
  type Rarity,
  type StatName
} from './types.ts'

const SALT = 'friend-2026-401'
const HATS_WITH_HAT = HATS.filter((hat) => hat !== 'none')

function mulberry32(seed: number): () => number {
  let value = seed >>> 0

  return () => {
    value |= 0
    value = (value + 0x6d2b79f5) | 0
    let next = Math.imul(value ^ (value >>> 15), 1 | value)
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(value: string): number {
  let hash = 2166136261

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

export function seededIndex(seed: string, namespace: string, length: number): number {
  if (length <= 0) return 0
  const hash = hashString(`${seed}:${namespace}`)
  const rng = mulberry32(hash)
  return Math.floor(rng() * length)
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!
}

function rollRarity(rng: () => number): Rarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((sum, value) => sum + value, 0)
  let cursor = rng() * total

  for (const rarity of RARITIES) {
    cursor -= RARITY_WEIGHTS[rarity]
    if (cursor < 0) return rarity
  }

  return 'common'
}

function rollStats(rng: () => number, rarity: Rarity): Record<StatName, number> {
  const floor = RARITY_FLOOR[rarity]
  const peak = pick(rng, STAT_NAMES)
  let dump = pick(rng, STAT_NAMES)
  while (dump === peak) dump = pick(rng, STAT_NAMES)

  const stats = {} as Record<StatName, number>
  for (const name of STAT_NAMES) {
    if (name === peak) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    } else if (name === dump) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    } else {
      stats[name] = floor + Math.floor(rng() * 40)
    }
  }

  return stats
}

export interface Roll {
  readonly bones: CompanionBones
  readonly inspirationSeed: number
}

function rollFrom(rng: () => number, speciesList: readonly string[]): Roll {
  const rarity = rollRarity(rng)
  const bones: CompanionBones = {
    rarity,
    species: pick(rng, speciesList),
    eye: pick(rng, EYES),
    hat: rarity === 'common' ? 'none' : pick(rng, HATS_WITH_HAT),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity)
  }

  return { bones, inspirationSeed: Math.floor(rng() * 1e9) }
}

export function roll(userId: string, speciesList: readonly string[]): Roll {
  const key = `${userId}:${SALT}`
  return rollFrom(mulberry32(hashString(key)), speciesList)
}

export function statBar(name: string, value: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, value))
  const bar = renderProportionalBar(
    [
      { label: 'filled', value: clamped, char: '█' },
      { label: 'empty', value: 100 - clamped, char: '░' }
    ],
    { width }
  )
  return `${name.padEnd(9)} [${bar}] ${clamped}`
}
