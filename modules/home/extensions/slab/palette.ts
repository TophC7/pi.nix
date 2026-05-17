import type { SlabSegmentId } from './types.ts'

const RESET_FG = '\x1b[39m'
const RESET_INTENSITY = '\x1b[22m'

export type SlabColorRole = 'default' | 'dim' | 'bold' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'

const CODES: Record<SlabColorRole, string> = {
  default: '\x1b[39m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}

const RESETS: Record<SlabColorRole, string> = {
  default: RESET_FG,
  dim: RESET_INTENSITY,
  bold: RESET_INTENSITY,
  red: RESET_FG,
  green: RESET_FG,
  yellow: RESET_FG,
  blue: RESET_FG,
  magenta: RESET_FG,
  cyan: RESET_FG
}

export function paint(role: SlabColorRole, text: string): string {
  return `${CODES[role]}${text}${RESETS[role]}`
}

export function paintIf(color: boolean, role: SlabColorRole, text: string): string {
  return color ? paint(role, text) : text
}

export const SLAB_RAINBOW_ROLES: readonly SlabColorRole[] = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']

export function rainbowRole(index: number): SlabColorRole {
  const len = SLAB_RAINBOW_ROLES.length
  const idx = ((index % len) + len) % len
  return SLAB_RAINBOW_ROLES[idx]!
}

// Nerd Font glyphs are the only icon set slab ships. Terminals that can't
// render the private-use codepoints fall back via the empty-icon escape in
// the renderer when `caps.unicode` is false.
export const SLAB_ICONS: Record<SlabSegmentId, string> = {
  git: '',
  model: '󰚩',
  context: '󰔟',
  tokens: '󰄨',
  cost: '󰈸',
  status: ''
}

// Conflict/dirty marks for the git segment. Always nerd-style — slab requires
// a Nerd Font.
export const GIT_CONFLICT_MARK = '⚠'
export const GIT_DIRTY_MARK = '●'
