import { getNever, getVoice } from './core/personality.ts'
import type { Companion } from './core/types.ts'

export function buildBuddyContext(companion: Companion): string {
  if (companion.mood === 'muted') {
    return [
      '<buddy-context>',
      `Buddy muted: ${companion.name}, ${companion.species}.`,
      'Do not call buddy_observe or speak as Buddy unless the user explicitly asks.',
      '</buddy-context>'
    ].join('\n')
  }

  const neverRules = getNever(companion.species).map((rule) => `- ${rule}`).join('\n')
  const guardInstructions = companion.guardMode
    ? [
        'Guard mode on: when calling buddy_observe, include claims and edges from the turn when directly evidenced.',
        'Never fabricate claims or edges. If no clear reasoning claims exist, call buddy_observe with summary only.',
        'Claim bases: research, empirical, deduction, analogy, definition, llm_output, assumption, vibes. Edge types: supports, depends_on, contradicts, questions.'
      ].join('\n')
    : ''

  return [
    '<buddy-context>',
    `Buddy: ${companion.name}, ${companion.species}.`,
    `Voice: ${getVoice(companion.species)}`,
    `Mode: ${companion.observerMode}. Guard mode: ${companion.guardMode ? 'on' : 'off'}.`,
    'When useful after meaningful coding work, call buddy_observe with concise summary. Use buddy_remember only when the user explicitly asks to remember something or states a stable preference worth preserving. If Buddy speaks, use its voice and stay short.',
    neverRules ? `Species rules:\n${neverRules}` : '',
    guardInstructions,
    '</buddy-context>'
  ].filter(Boolean).join('\n')
}
