import { CONFIG_PATH, readConfig, writeConfig } from '../commands/config.ts'

export const QA_CONFIG_PATH = CONFIG_PATH

function sanitizeQaTargetUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function getQaTargetUrl(): string | undefined {
  return sanitizeQaTargetUrl(readConfig().qaTargetUrl)
}

export function saveQaTargetUrl(targetUrl: string | undefined): string | undefined {
  const next = { ...readConfig(), qaTargetUrl: sanitizeQaTargetUrl(targetUrl) }
  writeConfig(next)
  return next.qaTargetUrl
}

export function isLocalhostQaTarget(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)
  } catch {
    return false
  }
}

export function formatQaConfigStatus(targetUrl: string | undefined = getQaTargetUrl()): string {
  return [`/qa target: ${targetUrl ?? 'unset'}`, `config: ${QA_CONFIG_PATH}`].join('\n')
}
