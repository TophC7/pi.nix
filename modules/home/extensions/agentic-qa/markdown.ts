export function fenced(language: string, value: string): string {
  return `\`\`\`${language}\n${value}\n\`\`\``
}
