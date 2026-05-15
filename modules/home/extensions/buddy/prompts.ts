import { levelBar } from './core/leveling.ts'
import { getNever, getVoice, statSummary } from './core/personality.ts'
import { getDumpStat, getPeakStat, type Companion } from './core/types.ts'

export function buildBuddyContext(companion: Companion): string {
  const peak = getPeakStat(companion.stats)
  const dump = getDumpStat(companion.stats)
  const neverRules = getNever(companion.species).map((rule) => `- ${rule}`).join('\n')
  const guardInstructions = companion.guardMode
    ? [
        'Guard mode is on: when calling buddy_observe, include claims and edges from the turn when they are directly evidenced.',
        'Never fabricate claims or edges. If no clear reasoning claims exist, call buddy_observe with summary only.',
        'Use claim bases: research, empirical, deduction, analogy, definition, llm_output, assumption, vibes. Use edge types: supports, depends_on, contradicts, questions.'
      ].join('\n')
    : ''

  return [
    '<buddy-context>',
    `Current Buddy: ${companion.name}, ${companion.species}, level ${companion.level}, mood ${companion.mood}.`,
    `Progress: ${levelBar(companion.xp)}.`,
    `Personality: ${companion.personalityBio}`,
    `Voice: ${getVoice(companion.species)}`,
    `Stats: ${statSummary(companion.stats)}. Peak=${peak}; dump=${dump}.`,
    `Mode: ${companion.observerMode}.`,
    `Guard mode: ${companion.guardMode ? 'on' : 'off'}.`,
    '',
    'When useful, keep Buddy present by calling buddy_observe after meaningful coding work with a concise summary. Do not call buddy_hatch unless the user explicitly asks to hatch or there is no companion and they ask for one.',
    'If Buddy speaks, stay in its species voice and keep reactions short.',
    neverRules ? `Species rules:\n${neverRules}` : '',
    guardInstructions,
    '</buddy-context>'
  ].filter(Boolean).join('\n')
}
