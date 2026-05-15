export const MAX_LEVEL = 50

export const XP_REWARDS: Record<string, number> = {
  observe: 5,
  commit: 10,
  bug_fix: 15,
  deploy: 25,
  session: 3
}

export function xpForLevel(level: number): number {
  if (level <= 1) return 0
  return Math.floor(5 * Math.pow(level, 1.8))
}

export function totalXpForLevel(level: number): number {
  let total = 0

  for (let cursor = 2; cursor <= level; cursor++) {
    total += xpForLevel(cursor)
  }

  return total
}

export function levelFromXp(totalXp: number): number {
  let level = 1
  let accumulated = 0

  while (level < MAX_LEVEL) {
    const needed = xpForLevel(level + 1)
    if (accumulated + needed > totalXp) break
    accumulated += needed
    level++
  }

  return level
}

export interface LevelProgress {
  readonly level: number
  readonly currentXp: number
  readonly neededXp: number
  readonly progress: number
}

export function levelProgress(totalXp: number): LevelProgress {
  const level = levelFromXp(totalXp)
  if (level >= MAX_LEVEL) return { level, currentXp: 0, neededXp: 0, progress: 1 }

  const currentLevelFloor = totalXpForLevel(level)
  const currentXp = totalXp - currentLevelFloor
  const neededXp = xpForLevel(level + 1)
  const progress = neededXp > 0 ? currentXp / neededXp : 1

  return { level, currentXp, neededXp, progress }
}

export function levelBar(totalXp: number): string {
  const progress = levelProgress(totalXp)
  if (progress.level >= MAX_LEVEL) return `Lv.${MAX_LEVEL} MAX`

  const width = 10
  const filled = Math.floor(progress.progress * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return `Lv.${progress.level} [${bar}] ${progress.currentXp}/${progress.neededXp} XP`
}
