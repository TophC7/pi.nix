import { levelProgress } from './leveling.ts'
import { statBar } from './rng.ts'
import { renderSprite } from './species.ts'
import { RARITY_STARS, STAT_NAMES, type Companion } from './types.ts'

export function renderCard(companion: Companion): string {
  const art = renderSprite(companion)
  const stars = RARITY_STARS[companion.rarity]
  const statLines = STAT_NAMES.map((stat) => statBar(stat, companion.stats[stat]))
  const width = 44
  const inner = width - 4
  const topBorder = '.' + '_'.repeat(width - 2) + '.'
  const bottomBorder = "'" + '_'.repeat(width - 2) + "'"
  const emptyLine = `| ${' '.repeat(inner)} |`
  const line = (text: string) => `| ${text.padEnd(inner)} |`
  const progress = levelProgress(companion.xp)
  const levelLine = progress.level >= 50
    ? 'Lv.50 MAX'
    : `Lv.${progress.level} · ${progress.currentXp}/${progress.neededXp} XP to next`

  return [
    topBorder,
    line(`${companion.name} · ${companion.species} ${stars}`),
    line(companion.shiny ? '✨ shiny companion' : `mood: ${companion.mood}`),
    emptyLine,
    ...art.map(line),
    emptyLine,
    line(companion.personalityBio),
    emptyLine,
    ...statLines.map(line),
    emptyLine,
    line(levelLine),
    bottomBorder
  ].join('\n')
}

export function hatchAnimation(companion: Companion): string {
  const egg1 = [
    '        ',
    '   .--. ',
    '  /    \\',
    ' |  ??  |',
    '  \\    /',
    "   '--' "
  ].join('\n')
  const egg2 = [
    '    *   ',
    '   .--. ',
    '  / *  \\',
    ' | \\??/ |',
    '  \\  * /',
    "   '--' "
  ].join('\n')
  const crack = [
    '    *    ',
    '   \\  /   ',
    "    `´    "
  ].join('\n')
  const art = renderSprite(companion)
  const hatched = [
    '  · ✦ · ',
    ' ✦ · · ✦ ',
    ...art,
    ' ✦ · · ✦ ',
    '  · ✦ · '
  ].join('\n')

  return [egg1, egg2, crack, hatched, renderCard(companion)].join('\n\n')
}
