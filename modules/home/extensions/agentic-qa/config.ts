import { CONFIG_PATH, readConfig, writeConfig } from '../commands/config.ts'

export const QA_CONFIG_PATH = CONFIG_PATH

export interface QaParallelConfig {
  readonly enabled: boolean
  readonly maxConcurrency: number
}

const DEFAULT_QA_PARALLEL_CONFIG: QaParallelConfig = { enabled: false, maxConcurrency: 1 }
const MAX_QA_PARALLEL_CONCURRENCY = 8

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

export function getQaParallelConfig(): QaParallelConfig {
  const raw = readConfig().qaParallel
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_QA_PARALLEL_CONFIG
  const candidate = raw as Record<string, unknown>
  const enabled = candidate.enabled === true
  const maxConcurrency = sanitizeMaxConcurrency(candidate.maxConcurrency)
  return enabled ? { enabled, maxConcurrency } : DEFAULT_QA_PARALLEL_CONFIG
}

export function saveQaParallelConfig(config: Partial<QaParallelConfig>): QaParallelConfig {
  const nextConfig = sanitizeQaParallelConfig(config)
  const next = { ...readConfig(), qaParallel: nextConfig }
  writeConfig(next)
  return nextConfig
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
  const parallel = getQaParallelConfig()
  return [
    `/qa target: ${targetUrl ?? 'unset'}`,
    `/qa parallel: ${parallel.enabled ? `on (max ${parallel.maxConcurrency})` : 'off'}`,
    `config: ${QA_CONFIG_PATH}`
  ].join('\n')
}

function sanitizeQaParallelConfig(config: Partial<QaParallelConfig>): QaParallelConfig {
  const enabled = config.enabled === true
  return enabled ? { enabled, maxConcurrency: sanitizeMaxConcurrency(config.maxConcurrency) } : DEFAULT_QA_PARALLEL_CONFIG
}

function sanitizeMaxConcurrency(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_QA_PARALLEL_CONFIG.maxConcurrency
  return Math.max(1, Math.min(MAX_QA_PARALLEL_CONCURRENCY, Math.floor(numeric)))
}
