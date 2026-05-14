import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, normalize, relative } from 'node:path'
import { resolveInside } from './paths.ts'
import { classifyHardeningMetadata } from './review-hardening.ts'
import type { SaveResult } from './types.ts'

function requireMetadata(content: string): void {
  const result = classifyHardeningMetadata(content)
  if (result.status === 'missing') {
    throw new Error(result.errors[0] ?? 'Missing AskClaude hardening metadata or explicit waiver.')
  }
}

export function saveFile(root: string, path: string, content: string, metadataRequired = true): SaveResult {
  const normalized = normalize(path)
  const fullPath = resolveInside(root, normalized)
  if (metadataRequired) requireMetadata(content)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
  return {
    path: relative(process.cwd(), fullPath),
    bytes: Buffer.byteLength(content)
  }
}

export function readFrontmatterValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
  return match?.[1]?.trim() ?? ''
}
