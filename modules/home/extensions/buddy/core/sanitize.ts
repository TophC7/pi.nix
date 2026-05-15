const MAX_NAME_LENGTH = 40
const MAX_MEMORY_LENGTH = 2000

export function sanitizeName(name: string | undefined): string {
  if (!name) return ''

  return name
    .replace(/[\p{Cf}\p{Cc}\p{Co}]/gu, '')
    .replace(/[{}$`\\]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

export function sanitizeMemory(content: string): string {
  return content
    .replace(/[\p{Cf}\p{Cc}\p{Co}]/gu, '')
    .replace(/[{}$`]/g, '')
    .trim()
    .slice(0, MAX_MEMORY_LENGTH)
}
