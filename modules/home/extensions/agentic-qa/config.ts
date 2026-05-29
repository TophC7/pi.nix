import { registerConfigSection } from '@pi/lib/config-registry'
import type { RuntimeProfile, ThinkingLevel } from '@pi/lib/runtime-profile'
import {
  QA_WORKSPACE_CONFIG_PATH,
  QA_WORKSPACE_LOCAL_CONFIG_PATH,
  loadQaWorkspaceConfig,
  readQaWorkspaceSharedConfig,
  writeQaWorkspaceSharedConfig
} from './workspace-config.ts'

export const QA_CONFIG_PATH = QA_WORKSPACE_CONFIG_PATH

const QA_RUNTIME_PROFILE_ROLES = ['default', 'planner', 'setup', 'worker'] as const
type QaRuntimeProfileRole = (typeof QA_RUNTIME_PROFILE_ROLES)[number]

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

function getQaRuntimeProfile(role: QaRuntimeProfileRole, cwd: string): RuntimeProfile {
  const profiles = loadQaWorkspaceConfig(cwd).runtimeProfiles
  return role === 'default' ? profiles.default ?? {} : profiles[role] ?? {}
}

function saveQaRuntimeProfile(role: QaRuntimeProfileRole, profile: RuntimeProfile, cwd: string): void {
  const next: Record<string, unknown> = { ...readQaWorkspaceSharedConfig(cwd) }
  if (role === 'default') {
    setObjectField(next, 'runtimeProfile', compactRuntimeProfile(profile))
  } else {
    const profiles = objectOrEmpty(next.profiles)
    setObjectField(profiles, role, compactRuntimeProfile(profile))
    setObjectField(next, 'profiles', Object.keys(profiles).length > 0 ? profiles : undefined)
  }
  writeQaWorkspaceSharedConfig(cwd, next)
}

function getQaSetup(cwd: string): string | undefined {
  const setup = loadQaWorkspaceConfig(cwd).setup
  return setup.length > 0 ? setup.join('; ') : undefined
}

function saveQaSetup(value: string | undefined, cwd: string): void {
  const next: Record<string, unknown> = { ...readQaWorkspaceSharedConfig(cwd) }
  const setup = value
    ?.split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
  setObjectField(next, 'setup', setup && setup.length > 0 ? setup : undefined)
  writeQaWorkspaceSharedConfig(cwd, next)
}

function compactRuntimeProfile(profile: RuntimeProfile): RuntimeProfile | undefined {
  const compact: RuntimeProfile = {
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinking ? { thinking: profile.thinking } : {})
  }
  return compact.model || compact.thinking ? compact : undefined
}

function setObjectField(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
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
  return [
    `/qa model: ${profile?.model ?? 'default'}`,
    `/qa thinking: ${profile?.thinking ?? 'default'}`,
    `/qa target: ${resolvedTargetUrl ?? 'unset'}`,
    `writes: ${QA_WORKSPACE_CONFIG_PATH}`,
    `local override: ${QA_WORKSPACE_LOCAL_CONFIG_PATH}`
  ].join('\n')
}

export function registerQaConfigSection(): void {
  registerConfigSection({
    id: 'agentic-qa',
    title: 'Agentic QA',
    description: 'Workspace-owned settings for QA commands.',
    status: (ctx) => formatQaConfigStatus(ctx.cwd),
    rows: () => [
      {
        kind: 'text' as const,
        id: 'agentic-qa.target',
        label: '/qa',
        fieldLabel: 'target',
        description: 'Localhost URL used by /qa, /qa:staged, and /qa:freehand.',
        detail: `Writes shared config at ${QA_WORKSPACE_CONFIG_PATH}; ${QA_WORKSPACE_LOCAL_CONFIG_PATH} may override active values locally.`,
        source: qaConfigSource,
        placeholder: 'http://localhost:5173',
        unsetLabel: 'unset',
        get: (ctx) => getQaTargetUrl(ctx.cwd),
        set: (targetUrl, ctx) => saveQaTargetUrl(targetUrl, ctx.cwd),
        validate: (value) => (isLocalhostQaTarget(value) ? undefined : 'Target must be a localhost http(s) URL.')
      },
      {
        kind: 'text' as const,
        id: 'agentic-qa.setup',
        label: '/qa',
        fieldLabel: 'setup',
        description: 'Workspace setup context appended to QA run specs.',
        detail: 'Enter semicolon-separated setup lines. Use AGENTS.md for longer project QA notes.',
        source: qaConfigSource,
        placeholder: 'start dev server; seed local test data',
        unsetLabel: 'none',
        get: (ctx) => getQaSetup(ctx.cwd),
        set: (setup, ctx) => saveQaSetup(setup, ctx.cwd)
      },
      ...QA_RUNTIME_PROFILE_ROLES.flatMap(runtimeProfileRows)
    ]
  })
}

function runtimeProfileRows(role: QaRuntimeProfileRole) {
  const label = role === 'default' ? '/qa' : `/qa ${role}`
  const description = role === 'default' ? 'Default runtime profile for QA parent/fallback flows and subagent roles without overrides.' : `Runtime profile override for QA ${role} subagents.`
  return [
    {
      kind: 'model' as const,
      id: `agentic-qa.profile.${role}.model`,
      label,
      description,
      source: qaConfigSource,
      get: (ctx) => getQaRuntimeProfile(role, ctx.cwd).model,
      set: (model: string | undefined, ctx) => saveQaRuntimeProfile(role, { ...getQaRuntimeProfile(role, ctx.cwd), model }, ctx.cwd)
    },
    {
      kind: 'thinking' as const,
      id: `agentic-qa.profile.${role}.thinking`,
      label,
      description,
      source: qaConfigSource,
      get: (ctx) => getQaRuntimeProfile(role, ctx.cwd).thinking,
      set: (thinking: ThinkingLevel | undefined, ctx) => saveQaRuntimeProfile(role, { ...getQaRuntimeProfile(role, ctx.cwd), thinking }, ctx.cwd)
    }
  ]
}

function qaConfigSource(): string {
  return `writes ${QA_WORKSPACE_CONFIG_PATH}; local override ${QA_WORKSPACE_LOCAL_CONFIG_PATH}`
}
