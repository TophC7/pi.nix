import { registerConfigSection } from '@pi/lib/config-registry'
import {
  QA_WORKSPACE_CONFIG_PATH,
  QA_WORKSPACE_LOCAL_CONFIG_PATH,
  loadQaWorkspaceConfig,
  readQaWorkspaceSharedConfig,
  sanitizeQaParallelConfig,
  writeQaWorkspaceSharedConfig,
  type QaParallelConfig
} from './workspace-config.ts'

export const QA_CONFIG_PATH = QA_WORKSPACE_CONFIG_PATH

const DEFAULT_QA_PARALLEL_CONFIG: QaParallelConfig = { enabled: false, maxConcurrency: 1 }

function sanitizeQaTargetUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function getQaTargetUrl(cwd: string): string | undefined {
  return loadQaWorkspaceConfig(cwd).targetUrl
}

export function saveQaTargetUrl(targetUrl: string | undefined, cwd: string): string | undefined {
  const sanitized = sanitizeQaTargetUrl(targetUrl)
  const next: Record<string, unknown> = { ...readQaWorkspaceSharedConfig(cwd), targetUrl: sanitized }
  if (!sanitized) delete next.targetUrl
  writeQaWorkspaceSharedConfig(cwd, next)
  return sanitized
}

export function getQaParallelConfig(cwd: string): QaParallelConfig {
  return loadQaWorkspaceConfig(cwd).parallel ?? DEFAULT_QA_PARALLEL_CONFIG
}

export function saveQaParallelConfig(config: Partial<QaParallelConfig>, cwd: string): QaParallelConfig {
  const nextConfig = sanitizeQaParallelConfig(config)
  const next: Record<string, unknown> = { ...readQaWorkspaceSharedConfig(cwd), parallel: nextConfig }
  writeQaWorkspaceSharedConfig(cwd, next)
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

export function formatQaConfigStatus(cwd: string, targetUrl?: string): string {
  const workspace = loadQaWorkspaceConfig(cwd)
  const profile = workspace.runtimeProfiles.default
  const resolvedTargetUrl = targetUrl ?? workspace.targetUrl
  const parallel = workspace.parallel ?? DEFAULT_QA_PARALLEL_CONFIG
  return [
    `/qa model: ${profile?.model ?? 'default'}`,
    `/qa thinking: ${profile?.thinking ?? 'default'}`,
    `/qa target: ${resolvedTargetUrl ?? 'unset'}`,
    `/qa parallel: ${parallel.enabled ? `on (max ${parallel.maxConcurrency})` : 'off'}`,
    `writes: ${QA_WORKSPACE_CONFIG_PATH}`,
    `local override: ${QA_WORKSPACE_LOCAL_CONFIG_PATH}`
  ].join('\n')
}

export function registerQaConfigSection(): void {
  registerConfigSection({
    id: 'agentic-qa',
    title: 'Agentic QA',
    description: 'Workspace-owned localhost target for QA commands.',
    status: (ctx) => formatQaConfigStatus(ctx.cwd),
    rows: () => [
      {
        kind: 'text' as const,
        id: 'agentic-qa.target',
        label: '/qa',
        fieldLabel: 'target',
        description: 'Localhost URL used by /qa, /qa:staged, and /qa:freehand.',
        detail: `Writes shared config at ${QA_WORKSPACE_CONFIG_PATH}; ${QA_WORKSPACE_LOCAL_CONFIG_PATH} may override active values locally.`,
        source: `writes ${QA_WORKSPACE_CONFIG_PATH}; local override ${QA_WORKSPACE_LOCAL_CONFIG_PATH}`,
        placeholder: 'http://localhost:5173',
        unsetLabel: 'unset',
        get: (ctx) => getQaTargetUrl(ctx.cwd),
        set: (targetUrl, ctx) => saveQaTargetUrl(targetUrl, ctx.cwd),
        validate: (value) => (isLocalhostQaTarget(value) ? undefined : 'Target must be a localhost http(s) URL.')
      }
    ]
  })
}
