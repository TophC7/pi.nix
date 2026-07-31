export const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'] as const
export type StatName = (typeof STAT_NAMES)[number]

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const
export type Rarity = (typeof RARITIES)[number]

export const EYES = ['·', '.', '×', '◉', '@', '°'] as const
export const SPARKLE_EYE = '✦'
export type Eye = (typeof EYES)[number] | typeof SPARKLE_EYE | '^'

export const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'] as const
export type Hat = (typeof HATS)[number]

export interface CompanionBones {
  readonly rarity: Rarity
  readonly species: string
  readonly eye: Eye
  readonly hat: Hat
  readonly shiny: boolean
  readonly stats: Record<StatName, number>
}

export interface CompanionSoul {
  readonly name: string
  readonly personalityBio: string
}

export type Companion = CompanionBones &
  CompanionSoul & {
    readonly id: string
    readonly level: number
    readonly xp: number
    readonly mood: string
    readonly availablePoints: number
    readonly hatchedAt: number
    readonly observerMode: string
    readonly guardMode: boolean
  }

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1
}

export const RARITY_FLOOR: Record<Rarity, number> = {
  common: 5,
  uncommon: 15,
  rare: 25,
  epic: 35,
  legendary: 50
}

export const RARITY_STARS: Record<Rarity, string> = {
  common: '★',
  uncommon: '★★',
  rare: '★★★',
  epic: '★★★★',
  legendary: '★★★★★'
}

export const HAT_LINES: Record<Hat, string> = {
  none: '',
  crown: '   \\^^^/    ',
  tophat: '   [___]    ',
  propeller: '    -+-     ',
  halo: '   (   )    ',
  wizard: '    /^\\     ',
  beanie: '   (___)    ',
  tinyduck: '    ,>      '
}

export function getPeakStat(stats: Record<StatName, number>): StatName {
  let peak = STAT_NAMES[0]
  let max = Number.NEGATIVE_INFINITY

  for (const name of STAT_NAMES) {
    if (stats[name] > max) {
      max = stats[name]
      peak = name
    }
  }

  return peak
}

export function getDumpStat(stats: Record<StatName, number>): StatName {
  let dump = STAT_NAMES[0]
  let min = Number.POSITIVE_INFINITY

  for (const name of STAT_NAMES) {
    if (stats[name] < min) {
      min = stats[name]
      dump = name
    }
  }

  return dump
}
