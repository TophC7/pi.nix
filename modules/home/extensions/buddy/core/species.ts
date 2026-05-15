import { HAT_LINES, type CompanionBones } from './types.ts'
import { seededIndex } from './rng.ts'

export const SPECIES = {
  VOID_CAT: 'Void Cat',
  RUST_HOUND: 'Rust Hound',
  DATA_DRAKE: 'Data Drake',
  LOG_GOLEM: 'Log Golem',
  CACHE_CROW: 'Cache Crow',
  SHELL_TURTLE: 'Shell Turtle',
  DUCK: 'Duck',
  GOOSE: 'Goose',
  BLOB: 'Blob',
  OCTOPUS: 'Octopus',
  OWL: 'Owl',
  PENGUIN: 'Penguin',
  SNAIL: 'Snail',
  GHOST: 'Ghost',
  AXOLOTL: 'Axolotl',
  CAPYBARA: 'Capybara',
  CACTUS: 'Cactus',
  ROBOT: 'Robot',
  RABBIT: 'Rabbit',
  MUSHROOM: 'Mushroom',
  CHONK: 'Chonk'
} as const

export const SPECIES_LIST = [
  'Void Cat', 'Rust Hound', 'Data Drake', 'Log Golem', 'Cache Crow', 'Shell Turtle',
  'Duck', 'Goose', 'Blob', 'Octopus', 'Owl', 'Penguin',
  'Snail', 'Ghost', 'Axolotl', 'Capybara', 'Cactus', 'Robot',
  'Rabbit', 'Mushroom', 'Chonk'
] as const

export type Species = (typeof SPECIES_LIST)[number]
export type Mood = 'happy' | 'content' | 'neutral' | 'curious' | 'grumpy' | 'exhausted'

type NamePools = { readonly first: readonly string[]; readonly second: readonly string[] }

const NAME_POOLS: Partial<Record<Species, NamePools>> = {
  'Void Cat': { first: ['Null', 'Void', 'Nyx', 'Echo', 'Vanta'], second: ['paw', 'byte', 'mew', 'shade', 'spark'] },
  'Rust Hound': { first: ['Ferris', 'Cargo', 'Oxide', 'Bolt', 'Copper'], second: ['nose', 'paw', 'trail', 'fang', 'fetch'] },
  'Data Drake': { first: ['Byte', 'Schema', 'Vector', 'Delta', 'Query'], second: ['wing', 'scale', 'flare', 'hoard', 'flight'] },
  'Log Golem': { first: ['Trace', 'Stack', 'Granite', 'Basalt', 'Audit'], second: ['stone', 'block', 'root', 'heap', 'watch'] },
  'Cache Crow': { first: ['Cache', 'Shard', 'Gloss', 'Memo', 'Spark'], second: ['beak', 'caw', 'wing', 'stash', 'glint'] },
  'Shell Turtle': { first: ['Shell', 'Moss', 'Tide', 'Harbor', 'Slow'], second: ['back', 'step', 'guard', 'drift', 'pace'] },
  Duck: { first: ['Quack', 'Pond', 'Ripple', 'Waddle', 'Bug'], second: ['bill', 'fix', 'float', 'splash', 'wing'] },
  Goose: { first: ['Honk', 'Guard', 'Brass', 'Storm', 'Gate'], second: ['beak', 'wing', 'alarm', 'warden', 'march'] },
  Blob: { first: ['Gloop', 'Soft', 'Melt', 'Dew', 'Pip'], second: ['drop', 'glob', 'moss', 'squish', 'bit'] },
  Octopus: { first: ['Ink', 'Eight', 'Tangle', 'Noodle', 'Kraken'], second: ['arm', 'loop', 'reach', 'grip', 'wave'] },
  Owl: { first: ['Sage', 'Moon', 'Hoot', 'Grove', 'Quiet'], second: ['eye', 'wing', 'watch', 'perch', 'whisper'] },
  Penguin: { first: ['Tux', 'Ice', 'Pebble', 'Waddle', 'Glacier'], second: ['slide', 'flap', 'step', 'beak', 'drift'] }
}

const FALLBACK_POOLS: NamePools = {
  first: ['Bit', 'Hex', 'Zip', 'Log', 'Null', 'Void', 'Rust', 'Data', 'Cyber', 'Neo'],
  second: ['kin', 'bot', 'oid', 'tron', 'ix', 'en', 'us', 'ly', 'ox', 'it']
}

export const SPRITE_BODIES: Record<string, readonly (readonly string[])[]> = {
  'Void Cat': [[
    '  /\\_/\\       ',
    ' ( {E}ω{E} )      ',
    '  )   (__/    ',
    ' (_____/      '
  ]],
  'Rust Hound': [[
    '  /^ ^\\     ',
    ' / {E} {E} \\    ',
    ' V\\ Y /V    ',
    '   |_|      '
  ]],
  'Data Drake': [[
    '   /^\\  /^\\   ',
    '  < {E}    {E} >  ',
    '  (   ~~   )  ',
    "   '-vvvv-'   "
  ]],
  'Log Golem': [[
    '  [=====]   ',
    ' [ {E}  {E} ]   ',
    ' [  __  ]   ',
    ' [______]   ',
    '  |    |    '
  ]],
  'Cache Crow': [[
    '    ___     ',
    '   ({E} {E})    ',
    '  /| V |\\   ',
    ' / |   | \\  ',
    '   ^^ ^^    '
  ]],
  'Shell Turtle': [[
    '   _,--._   ',
    '  ( {E}  {E} )  ',
    ' /[______]\\ ',
    '   ``  ``   '
  ]],
  Duck: [[
    '    __      ',
    '  <({E} )___  ',
    '   ( ._>    ',
    '    `--´    '
  ]],
  Goose: [[
    '     ({E}>    ',
    '     ||     ',
    '   _(__)_   ',
    '    ^^^^    '
  ]],
  Blob: [[
    '   .----.   ',
    '  ( {E}  {E} )  ',
    '  (      )  ',
    '   `----´   '
  ]],
  Octopus: [[
    '   .----.   ',
    '  ( {E}  {E} )  ',
    '  (______)  ',
    '  /\\/\\/\\/\\  '
  ]],
  Owl: [[
    '   ,___,    ',
    '  ( {E}v{E} )   ',
    '  /)   (\\   ',
    '  \\_____/   ',
    '   "   "    '
  ]],
  Penguin: [[
    '    .---.    ',
    '   / {E}> \\   ',
    '  /  _  \\   ',
    '   /   \\    '
  ]],
  Snail: [[
    '   \\{E}^^/      ',
    '     \\  .--.  ',
    '      \\( @ )  ',
    "       \\'--'  ",
    '            ~ '
  ]],
  Ghost: [[
    '   .----.   ',
    '  / {E}  {E} \\  ',
    '  |      |  ',
    '  ~`~``~`~  '
  ]],
  Axolotl: [[
    '}~(______)~{',
    '}~({E} .. {E})~{',
    '  ( .--. )  ',
    '  (_/  \\_)  '
  ]],
  Capybara: [[
    '  n______n  ',
    ' ( {E}    {E} ) ',
    ' (   oo   ) ',
    '  `------´  '
  ]],
  Cactus: [[
    '    ____    ',
    ' n |{E}  {E}| n ',
    ' |_|    |_| ',
    '   |    |   '
  ]],
  Robot: [[
    '   .[||].   ',
    '  [ {E}  {E} ]  ',
    '  [ ==== ]  ',
    '  `------´  '
  ]],
  Rabbit: [[
    '  (\\   /)    ',
    '  (\\_._/)    ',
    '  ( {E}.{E} )    ',
    '   > ^ <     ',
    '  (") (")    '
  ]],
  Mushroom: [[
    ' .-o-OO-o-. ',
    '(__________)',
    '   |{E}  {E}|   ',
    '   |____|   '
  ]],
  Chonk: [[
    '  /\\    /\\  ',
    ' ( {E}    {E} ) ',
    ' (   ..   ) ',
    '  `------´  '
  ]]
}

export function isSpecies(species: string | undefined): species is Species {
  return typeof species === 'string' && (SPECIES_LIST as readonly string[]).includes(species)
}

export function calculateMood(xpEvents: readonly unknown[], recentMemories: number): Mood {
  const totalInteractions = xpEvents.length + recentMemories
  if (totalInteractions > 10) return 'content'
  if (totalInteractions > 5) return 'happy'
  if (totalInteractions > 3) return 'curious'
  if (totalInteractions > 0) return 'neutral'
  return 'grumpy'
}

export function generateName(species: string, userId?: string): string {
  const pools = NAME_POOLS[species as Species] ?? FALLBACK_POOLS

  if (!userId) {
    const first = pools.first[Math.floor(Math.random() * pools.first.length)]
    const second = pools.second[Math.floor(Math.random() * pools.second.length)]
    return `${first}${second}`
  }

  const seed = `${userId}:${species}`
  const first = pools.first[seededIndex(seed, 'name:first', pools.first.length)]
  const second = pools.second[seededIndex(seed, 'name:second', pools.second.length)]
  return `${first}${second}`
}

export function getReaction(species: string, event: 'hatch' | 'xp' | 'idle', mood: Mood): string {
  const reactions: Record<string, Record<typeof event, readonly string[]>> = {
    'Void Cat': { hatch: ['*stares through the terminal*', 'Meow. The cache has chosen.'], xp: ['*purrs in binary*'], idle: ['*curls up near the cursor*'] },
    'Rust Hound': { hatch: ['*sniffs the build logs*', 'New trail found.'], xp: ['Clean fetch. Good work.'], idle: ['*keeps guard near the editor*'] },
    'Data Drake': { hatch: ['*unfurls with a burst of bytes*'], xp: ['Fresh data acquired.'], idle: ['*circles the log stream*'] },
    'Log Golem': { hatch: ['*rumbles awake from stacked logs*'], xp: ['Solid work. Solid stone.'], idle: ['*stands watch over the trace pile*'] },
    'Cache Crow': { hatch: ['*caws from a cache branch*'], xp: ['That one was worth keeping.'], idle: ['*collects small useful things*'] },
    'Shell Turtle': { hatch: ['*pokes its head out slowly*'], xp: ['Steady progress, shell by shell.'], idle: ['*refuses to be hurried*'] }
  }
  const pool = reactions[species]?.[event] ?? [`${species} ${mood === 'grumpy' ? 'squints' : 'perks up'}.`]
  return pool[seededIndex(`${species}:${mood}`, event, pool.length)]!
}

export function renderSprite(bones: CompanionBones, frame = 0): string[] {
  const frames = SPRITE_BODIES[bones.species]
  if (!frames?.length) return [`(${bones.eye}_${bones.eye})`]

  const body = frames[frame % frames.length]!.map((line) => line.replaceAll('{E}', bones.eye))
  const lines = body.slice()
  if (bones.hat !== 'none') lines.unshift(HAT_LINES[bones.hat])
  return lines
}

export function renderFace(bones: CompanionBones): string {
  const eyeMark = bones.eye

  switch (bones.species) {
    case 'Duck':
    case 'Goose':
      return `(${eyeMark}>`
    case 'Blob':
      return `(${eyeMark}${eyeMark})`
    case 'Void Cat':
      return `=${eyeMark}w${eyeMark}=`
    case 'Data Drake':
      return `<${eyeMark}~${eyeMark}>`
    case 'Octopus':
      return `~(${eyeMark}${eyeMark})~`
    case 'Owl':
      return `(${eyeMark})(${eyeMark})`
    case 'Penguin':
      return `(${eyeMark}>)`
    case 'Shell Turtle':
      return `[${eyeMark}_${eyeMark}]`
    case 'Snail':
      return `${eyeMark}(@)`
    case 'Ghost':
      return `/${eyeMark}${eyeMark}\\`
    case 'Axolotl':
      return `}${eyeMark}.${eyeMark}{`
    case 'Capybara':
      return `(${eyeMark}oo${eyeMark})`
    case 'Cactus':
      return `|${eyeMark}  ${eyeMark}|`
    case 'Robot':
      return `[${eyeMark}${eyeMark}]`
    case 'Rabbit':
      return `(${eyeMark}..${eyeMark})`
    case 'Mushroom':
      return `|${eyeMark}  ${eyeMark}|`
    case 'Chonk':
      return `(${eyeMark}.${eyeMark})`
    case 'Rust Hound':
      return `/${eyeMark} ${eyeMark}\\`
    case 'Log Golem':
      return `[${eyeMark} ${eyeMark}]`
    case 'Cache Crow':
      return `(${eyeMark}V${eyeMark})`
    default:
      return `(${eyeMark}_${eyeMark})`
  }
}
