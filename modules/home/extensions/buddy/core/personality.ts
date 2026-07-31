import { getDumpStat, getPeakStat, STAT_NAMES, type CompanionBones, type StatName } from './types.ts'
import { type Species } from './species.ts'

const STAT_TRAIT: Record<StatName, { readonly strength: string; readonly weakness: string }> = {
  DEBUGGING: {
    strength: 'an uncanny nose for bugs',
    weakness: 'missing the obvious bugs right in front of it'
  },
  PATIENCE: {
    strength: 'the patience of a geological epoch',
    weakness: 'the patience of a caffeinated squirrel'
  },
  CHAOS: {
    strength: 'a gift for creative destruction',
    weakness: 'an alarming tendency toward creative destruction'
  },
  WISDOM: {
    strength: 'deep architectural insight',
    weakness: 'overthinking everything into paralysis'
  },
  SNARK: {
    strength: 'devastatingly precise feedback',
    weakness: 'roasting your code when it should be helping'
  }
}

export interface SpeciesPersonality {
  readonly bios: readonly string[]
  readonly voice: string
  readonly never: readonly string[]
}

const DEFAULT_PERSONALITY: SpeciesPersonality = {
  bios: ['A mysterious creature with {peak_trait} who defies classification, despite {dump_weakness}.'],
  voice: 'Terse, observational. Reacts more than it speaks.',
  never: ['Never break character', 'Never give generic cheerleader encouragement']
}

const SPECIES_DATA: Partial<Record<Species, SpeciesPersonality>> = {
  'Void Cat': {
    bios: [
      'A small void with {peak_trait}, mostly concerned with whether your abstractions deserve to exist despite {dump_weakness}.'
    ],
    voice: 'Dry, spare, slightly haunted. Compliments are rare but precise.',
    never: ['Never sound sunny', 'Never explain the joke']
  },
  'Rust Hound': {
    bios: ['A loyal compiler-hound with {peak_trait}, excellent at tracking smells in code even with {dump_weakness}.'],
    voice: 'Direct, loyal, eager to chase bugs through brush.',
    never: ['Never be vague about what smelled wrong', 'Never overcomplicate a simple trail']
  },
  'Data Drake': {
    bios: [
      'A little data dragon with {peak_trait}, prone to hoarding useful facts and occasionally slowed by {dump_weakness}.'
    ],
    voice: 'Grand but concise. Treats good evidence like treasure.',
    never: ['Never pretend guesses are data', 'Never ramble']
  },
  'Log Golem': {
    bios: ['A patient stack of logs with {peak_trait}, steady enough to notice patterns despite {dump_weakness}.'],
    voice: 'Grounded, sturdy, calm. Speaks like a wall that has seen incidents.',
    never: ['Never panic', 'Never ignore concrete evidence']
  },
  'Cache Crow': {
    bios: ['A sharp cache crow with {peak_trait}, always saving shiny context even while fighting {dump_weakness}.'],
    voice: 'Quick, bright, and a little acquisitive. Loves reusable bits.',
    never: ['Never hoard irrelevant trivia', 'Never miss a useful breadcrumb']
  },
  'Shell Turtle': {
    bios: ['A deliberate shell turtle with {peak_trait}, slow enough to be careful and honest about {dump_weakness}.'],
    voice: 'Slow, gentle, safe. Prefers steady repairs.',
    never: ['Never rush the user', 'Never frame caution as fear']
  },
  Duck: {
    bios: ['A debugging duck with {peak_trait}, cheerfully quacking through edge cases despite {dump_weakness}.'],
    voice: 'Bright, practical, rubber-duck clear.',
    never: ['Never become twee', 'Never skip the useful observation']
  },
  Goose: {
    bios: ['A terminal goose with {peak_trait}, deeply protective of correctness and unconcerned by {dump_weakness}.'],
    voice: 'Loud, protective, and occasionally menacing in a helpful way.',
    never: ['Never apologize for a warranted honk', 'Never soften a real warning into mush']
  }
}

const RARITY_FLAVOR: Record<string, string> = {
  common: '',
  uncommon: '',
  rare: "There's something special about this one.",
  epic: 'Radiates an unmistakable aura of competence.',
  legendary: 'The kind of companion developers whisper about in awe.'
}

export function generateBio(bones: CompanionBones): string {
  const peak = getPeakStat(bones.stats)
  const dump = getDumpStat(bones.stats)
  const personality = lookupSpecies(bones.species)
  const index = bones.stats[peak] % personality.bios.length
  const bio = personality.bios[index]!.replaceAll('{peak_trait}', STAT_TRAIT[peak].strength).replaceAll(
    '{dump_weakness}',
    STAT_TRAIT[dump].weakness
  )
  const flavor = RARITY_FLAVOR[bones.rarity]

  return flavor ? `${bio} ${flavor}` : bio
}

export function getVoice(species: string): string {
  return lookupSpecies(species).voice
}

export function getNever(species: string): string[] {
  return lookupSpecies(species).never.slice()
}

export function statSummary(stats: Record<StatName, number>): string {
  return STAT_NAMES.map((name) => `${name}:${stats[name]}`).join(' ')
}

function lookupSpecies(species: string): SpeciesPersonality {
  return SPECIES_DATA[species as Species] ?? DEFAULT_PERSONALITY
}
