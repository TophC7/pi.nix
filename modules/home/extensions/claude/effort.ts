export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const PI_TO_CLAUDE_EFFORT: Record<string, ClaudeEffort> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
}

export function claudeEffort(reasoning: string | undefined): ClaudeEffort | undefined {
  return reasoning ? PI_TO_CLAUDE_EFFORT[reasoning] : undefined
}
