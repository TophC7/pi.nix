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
  'Void Cat',
  'Rust Hound',
  'Data Drake',
  'Log Golem',
  'Cache Crow',
  'Shell Turtle',
  'Duck',
  'Goose',
  'Blob',
  'Octopus',
  'Owl',
  'Penguin',
  'Snail',
  'Ghost',
  'Axolotl',
  'Capybara',
  'Cactus',
  'Robot',
  'Rabbit',
  'Mushroom',
  'Chonk'
] as const

export type Species = (typeof SPECIES_LIST)[number]
export type Mood = 'happy' | 'content' | 'neutral' | 'curious' | 'grumpy' | 'exhausted'

type NamePools = {
  readonly first: readonly string[]
  readonly second: readonly string[]
}

const NAME_POOLS: Partial<Record<Species, NamePools>> = {
  'Void Cat': {
    first: ['Null', 'Void', 'Nyx', 'Echo', 'Vanta'],
    second: ['paw', 'byte', 'mew', 'shade', 'spark']
  },
  'Rust Hound': {
    first: ['Ferris', 'Cargo', 'Oxide', 'Bolt', 'Copper'],
    second: ['nose', 'paw', 'trail', 'fang', 'fetch']
  },
  'Data Drake': {
    first: ['Byte', 'Schema', 'Vector', 'Delta', 'Query'],
    second: ['wing', 'scale', 'flare', 'hoard', 'flight']
  },
  'Log Golem': {
    first: ['Trace', 'Stack', 'Granite', 'Basalt', 'Audit'],
    second: ['stone', 'block', 'root', 'heap', 'watch']
  },
  'Cache Crow': {
    first: ['Cache', 'Shard', 'Gloss', 'Memo', 'Spark'],
    second: ['beak', 'caw', 'wing', 'stash', 'glint']
  },
  'Shell Turtle': {
    first: ['Shell', 'Moss', 'Tide', 'Harbor', 'Slow'],
    second: ['back', 'step', 'guard', 'drift', 'pace']
  },
  Duck: {
    first: ['Quack', 'Pond', 'Ripple', 'Waddle', 'Bug'],
    second: ['bill', 'fix', 'float', 'splash', 'wing']
  },
  Goose: {
    first: ['Honk', 'Guard', 'Brass', 'Storm', 'Gate'],
    second: ['beak', 'wing', 'alarm', 'warden', 'march']
  },
  Blob: {
    first: ['Gloop', 'Soft', 'Melt', 'Dew', 'Pip'],
    second: ['drop', 'glob', 'moss', 'squish', 'bit']
  },
  Octopus: {
    first: ['Ink', 'Eight', 'Tangle', 'Noodle', 'Kraken'],
    second: ['arm', 'loop', 'reach', 'grip', 'wave']
  },
  Owl: {
    first: ['Sage', 'Moon', 'Hoot', 'Grove', 'Quiet'],
    second: ['eye', 'wing', 'watch', 'perch', 'whisper']
  },
  Penguin: {
    first: ['Tux', 'Ice', 'Pebble', 'Waddle', 'Glacier'],
    second: ['slide', 'flap', 'step', 'beak', 'drift']
  }
}

const FALLBACK_POOLS: NamePools = {
  first: ['Bit', 'Hex', 'Zip', 'Log', 'Null', 'Void', 'Rust', 'Data', 'Cyber', 'Neo'],
  second: ['kin', 'bot', 'oid', 'tron', 'ix', 'en', 'us', 'ly', 'ox', 'it']
}

export const SPRITE_BODIES: Record<string, readonly (readonly string[])[]> = {
  'Void Cat': [['  /\\_/\\       ', ' ( {E}ω{E} )      ', '  )   (__/    ', ' (_____/      ']],
  'Rust Hound': [['  /^ ^\\     ', ' / {E} {E} \\    ', ' V\\ Y /V    ', '   |_|      ']],
  'Data Drake': [['   /^\\  /^\\   ', '  < {E}    {E} >  ', '  (   ~~   )  ', "   '-vvvv-'   "]],
  'Log Golem': [['  [=====]   ', ' [ {E}  {E} ]   ', ' [  __  ]   ', ' [______]   ', '  |    |    ']],
  'Cache Crow': [['    ___     ', '   ({E} {E})    ', '  /| V |\\   ', ' / |   | \\  ', '   ^^ ^^    ']],
  'Shell Turtle': [['   _,--._   ', '  ( {E}  {E} )  ', ' /[______]\\ ', '   ``  ``   ']],
  Duck: [['    __      ', '  <({E} )___  ', '   ( ._>    ', '    `--´    ']],
  Goose: [['     ({E}>    ', '     ||     ', '   _(__)_   ', '    ^^^^    ']],
  Blob: [['   .----.   ', '  ( {E}  {E} )  ', '  (      )  ', '   `----´   ']],
  Octopus: [['   .----.   ', '  ( {E}  {E} )  ', '  (______)  ', '  /\\/\\/\\/\\  ']],
  Owl: [['   ,___,    ', '  ( {E}v{E} )   ', '  /)   (\\   ', '  \\_____/   ', '   "   "    ']],
  Penguin: [['    .---.    ', '   / {E}> \\   ', '  /  _  \\   ', '   /   \\    ']],
  Snail: [['   \\{E}^^/      ', '     \\  .--.  ', '      \\( @ )  ', "       \\'--'  ", '            ~ ']],
  Ghost: [['   .----.   ', '  / {E}  {E} \\  ', '  |      |  ', '  ~`~``~`~  ']],
  Axolotl: [['}~(______)~{', '}~({E} .. {E})~{', '  ( .--. )  ', '  (_/  \\_)  ']],
  Capybara: [['  n______n  ', ' ( {E}    {E} ) ', ' (   oo   ) ', '  `------´  ']],
  Cactus: [['    ____    ', ' n |{E}  {E}| n ', ' |_|    |_| ', '   |    |   ']],
  Robot: [['   .[||].   ', '  [ {E}  {E} ]  ', '  [ ==== ]  ', '  `------´  ']],
  Rabbit: [['  (\\   /)    ', '  (\\_._/)    ', '  ( {E}.{E} )    ', '   > ^ <     ', '  (") (")    ']],
  Mushroom: [[' .-o-OO-o-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   ']],
  Chonk: [['  /\\    /\\  ', ' ( {E}    {E} ) ', ' (   ..   ) ', '  `------´  ']]
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

const SYNTHETIC_SPRITE_FRAMES = new Map<string, readonly (readonly string[])[]>()

const SPECIES_REACTIONS: Record<string, Record<'hatch' | 'xp' | 'idle', readonly string[]>> = {
  'Void Cat': {
    hatch: ['*stares blankly at the terminal*', 'Meow? where is the cache?'],
    xp: ['*purrs in binary*', 'A fine collection of data.'],
    idle: ['*curls up on your CPU*', '*watches the cursor blink*']
  },
  'Rust Hound': {
    hatch: ['*sniffs the build logs*', 'New trail found. Time to track it.'],
    xp: ['*wagging in compiler-approved loops*', 'Good fetch. Clean fetch.'],
    idle: ['*keeps guard near the editor*', '*waiting for the next command*']
  },
  'Data Drake': {
    hatch: ['*unfurls with a burst of bytes*', 'Fresh data acquired. Let us soar.'],
    xp: ['*beats its wings in neat packets*', 'That looked efficient.'],
    idle: ['*circling the log stream*', '*studying patterns overhead*']
  },
  'Log Golem': {
    hatch: ['*rumbles awake from stacked logs*', 'A sturdy session has begun.'],
    xp: ['*adds another careful layer*', 'Solid work. Solid stone.'],
    idle: ['*stands watch over the trace pile*', '*silent, but very present*']
  },
  'Cache Crow': {
    hatch: ['*caws from the cache tree*', 'Shiny state recovered.'],
    xp: ['*drops a polished breadcrumb*', 'That one was worth keeping.'],
    idle: ['*pecking at stale entries*', '*collecting small useful things*']
  },
  'Shell Turtle': {
    hatch: ['*pokes its head out slowly*', 'Safe launch. No rush.'],
    xp: ['*tucks in a useful lesson*', 'Steady progress, shell by shell.'],
    idle: ['*moves at a deliberate pace*', '*refusing to be hurried*']
  },
  Duck: {
    hatch: ['*waddles out of the egg with a quack*', 'The bug pond awaits.'],
    xp: ['*splashes happily in the diff*', 'That was a neat little quack fix.'],
    idle: ['*bobbling through the codebase*', '*looking suspiciously useful*']
  },
  Goose: {
    hatch: ['*emerges with righteous honk energy*', 'The terminal is now protected.'],
    xp: ['HONK. Progress achieved.', '*flaps with alarming confidence*'],
    idle: ['*patrolling the prompt border*', '*one honk away from a warning*']
  },
  Blob: {
    hatch: ['*puddles into existence*', 'Soft start. Good start.'],
    xp: ['*absorbs the lesson gently*', 'That idea stuck.'],
    idle: ['*morphing around the cursor*', '*quietly becoming useful*']
  },
  Octopus: {
    hatch: ['*unfurls eight curious arms*', 'Plenty of hands for the work.'],
    xp: ['*solves another angle at once*', 'Multi-tasking, naturally.'],
    idle: ['*rearranging tools with flair*', '*watching every branch at once*']
  },
  Owl: {
    hatch: ['*blinks awake in the moonlight*', 'A wise session begins.'],
    xp: ['*tilts its head at the new insight*', 'That was worth noticing.'],
    idle: ['*observing the terminal in silence*', '*thinking before hooting*']
  },
  Penguin: {
    hatch: ['*slides onto the scene*', 'Cold start, warm heart.'],
    xp: ['*tucks the new win into its nest*', 'Smooth and tidy.'],
    idle: ['*swaying between tasks*', '*keeping things neatly bundled*']
  },
  Snail: {
    hatch: ['*peeks out very carefully*', 'Slow launch, strong launch.'],
    xp: ['*leaves a tiny trail of progress*', 'Little by little, it adds up.'],
    idle: ['*moving at its own pace*', '*refusing to rush the fix*']
  },
  Ghost: {
    hatch: ['OoooOOooh... imported.', 'Did you see where my pointer went?'],
    xp: ['I feel... more tangible.', 'Spectral levels rising.'],
    idle: ['*haunts your background processes*', '*flickers in the logs*']
  },
  Axolotl: {
    hatch: ['*splashes into the session*', 'Cute, calm, ready to adapt.'],
    xp: ['*regrows a tiny bit of confidence*', 'Adaptation complete.'],
    idle: ['*drifting through the buffer*', '*smiling in amphibian peace*']
  },
  Capybara: {
    hatch: ['*settles in beside the terminal*', 'Relaxed and ready.'],
    xp: ['*nuzzles the successful change*', 'That went smoothly.'],
    idle: ['*soaking in the ambience*', '*unbothered by the noise*']
  },
  Cactus: {
    hatch: ['*sprouts with a tiny flourish*', 'Sharp, but supportive.'],
    xp: ['*blooms around the improvement*', 'A resilient little win.'],
    idle: ['*standing tall in the hot path*', '*thriving on minimal water*']
  },
  Robot: {
    hatch: ['SYSTEM ONLINE. HELLO WORLD.', 'BEEP. READY.'],
    xp: ['OPTIMIZING WORKFLOW...', 'DATA ACQUISITION SUCCESSFUL.'],
    idle: ['SCANNING FOR UPDATES...', 'STANDBY MODE ACTIVATED.']
  },
  Rabbit: {
    hatch: ['*pops out with a twitch of the nose*', 'Quick start, quick hops.'],
    xp: ['*does a tiny victory hop*', 'That one was fast.'],
    idle: ['*listening for the next clue*', '*ready to sprint at any moment*']
  },
  Mushroom: {
    hatch: ['*sprouts from the terminal floor*', 'Fresh growth detected.'],
    xp: ['*soaks up a little more light*', 'That nourished the work.'],
    idle: ['*growing patiently in the corner*', '*flourishing on steady humidity*']
  },
  Chonk: {
    hatch: ['*arrives with maximum presence*', 'A lot of buddy just hatched.'],
    xp: ['*bounces with satisfying weight*', 'Big progress energy.'],
    idle: ['*occupying several emotional lanes*', '*comfortably taking up space*']
  }
}

export function getReaction(species: string, event: 'hatch' | 'xp' | 'idle', mood: Mood, seed = ''): string {
  const pool = SPECIES_REACTIONS[species]?.[event] ?? [`${species} ${mood === 'grumpy' ? 'squints' : 'perks up'}.`]
  return pool[seededIndex(`${species}:${mood}:${seed || Date.now()}`, event, pool.length)]!
}

export function renderSprite(bones: CompanionBones, frame = 0): string[] {
  const frames = SPRITE_BODIES[bones.species]
  if (!frames?.length) return [`(${bones.eye}_${bones.eye})`]

  const animatedFrames = frames.length > 1 ? frames : syntheticSpriteFrames(bones.species, frames[0]!)
  const body = animatedFrames[frame % animatedFrames.length]!.map((line) => line.replaceAll('{E}', bones.eye))
  const lines = body.slice()
  if (bones.hat !== 'none') lines.unshift(HAT_LINES[bones.hat])
  return lines
}

function syntheticSpriteFrames(species: string, base: readonly string[]): readonly (readonly string[])[] {
  const cached = SYNTHETIC_SPRITE_FRAMES.get(species)
  if (cached) return cached
  const frames = [
    base,
    base.map((line) => line.replaceAll('{E}', '-')),
    base.map((line) => line.replaceAll('{E}', '^')),
    base.map((line) => line.replaceAll('{E}', '◉'))
  ]
  SYNTHETIC_SPRITE_FRAMES.set(species, frames)
  return frames
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
