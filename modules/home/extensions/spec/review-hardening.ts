export type HardeningStatus = 'askclaude_pass' | 'waiver' | 'missing'

export interface HardeningParseResult {
  status: HardeningStatus
  errors: string[]
}

export function parseFrontmatterMetadata(content: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  return match?.[1] ?? undefined
}

export function classifyHardeningMetadata(content: string): HardeningParseResult {
  const metadata = parseFrontmatterMetadata(content)
  if (!metadata) return { status: 'missing', errors: ['Missing YAML frontmatter.'] }
  const askClaudePass = /hardened_by:\s*AskClaude/.test(metadata) && /hardened_status:\s*passed/.test(metadata)
  const waiver =
    /hardened_by:\s*waiver/.test(metadata) &&
    /hardened_status:\s*waived/.test(metadata) &&
    /waiver_reason:\s*\S/.test(metadata)
  if (askClaudePass) return { status: 'askclaude_pass', errors: [] }
  if (waiver) return { status: 'waiver', errors: [] }
  return {
    status: 'missing',
    errors: ['Review plan requires AskClaude pass metadata or explicit waiver metadata.']
  }
}

export function isHardeningSatisfied(content: string): boolean {
  return classifyHardeningMetadata(content).status !== 'missing'
}
