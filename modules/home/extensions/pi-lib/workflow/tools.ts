import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { getProfileToolNames } from './profiles.ts'
import type { WorkflowProfile } from './types.ts'

export interface WorkflowToolResolution {
  readonly profile: WorkflowProfile
  readonly allToolNames: readonly string[]
  readonly previousActiveTools: readonly string[]
  readonly nextActiveTools: readonly string[]
  readonly missingNeedsTools: readonly string[]
  readonly enabledNeedsTools: readonly string[]
  readonly enabledOptionalTools: readonly string[]
  readonly blockedActiveTools: readonly string[]
}

export interface WorkflowToolActivation extends WorkflowToolResolution {
  readonly activeAfterSet: readonly string[]
}

export class WorkflowToolResolutionError extends Error {
  constructor(
    message: string,
    readonly profile: WorkflowProfile,
    readonly missingNeedsTools: readonly string[]
  ) {
    super(message)
    this.name = 'WorkflowToolResolutionError'
  }
}

export class WorkflowToolActivationError extends Error {
  constructor(
    message: string,
    readonly activation: WorkflowToolResolution,
    readonly missingAfterSet: readonly string[]
  ) {
    super(message)
    this.name = 'WorkflowToolActivationError'
  }
}

export class WorkflowToolRestoreError extends Error {
  constructor(
    message: string,
    readonly expectedActiveTools: readonly string[],
    readonly actualActiveTools: readonly string[]
  ) {
    super(message)
    this.name = 'WorkflowToolRestoreError'
  }
}

export function resolveWorkflowTools(
  profile: WorkflowProfile,
  allToolNames: readonly string[],
  previousActiveTools: readonly string[]
): WorkflowToolResolution {
  const all = new Set(allToolNames)
  const previous = new Set(previousActiveTools)
  const needed = unique(profile.toolAccess.needsTools)
  const optional = unique(profile.toolAccess.optionalTools)
  const blocked = new Set(profile.toolAccess.blockedTools)
  const blockedNeeded = needed.filter((name) => blocked.has(name))
  if (blockedNeeded.length > 0) {
    throw new WorkflowToolResolutionError(
      `${profile.id} profile marks needed tools as blocked: ${blockedNeeded.join(', ')}`,
      profile,
      blockedNeeded
    )
  }

  const missingNeedsTools = needed.filter((name) => !all.has(name))
  const presentNeeded = needed.filter((name) => all.has(name))
  const presentOptional = optional.filter((name) => all.has(name) && !blocked.has(name))
  const exclusiveTools = profile.toolAccess.onlyAllowedTools
    ? unique(profile.toolAccess.onlyAllowedTools).filter((name) => all.has(name))
    : undefined
  const additiveTools = unique(previousActiveTools, presentNeeded, presentOptional)
  const nextActiveTools = unique(exclusiveTools ?? additiveTools).filter((name) => !blocked.has(name))
  const enabledNeedsTools = presentNeeded.filter((name) => !previous.has(name))
  const enabledOptionalTools = presentOptional.filter((name) => !previous.has(name))
  const blockedActiveTools = previousActiveTools.filter((name) => blocked.has(name))

  return {
    profile,
    allToolNames: unique(allToolNames),
    previousActiveTools: unique(previousActiveTools),
    nextActiveTools,
    missingNeedsTools,
    enabledNeedsTools,
    enabledOptionalTools,
    blockedActiveTools
  }
}

export function assertNeedsToolsPresent(resolution: WorkflowToolResolution): void {
  if (resolution.missingNeedsTools.length === 0) return
  throw new WorkflowToolResolutionError(
    `${resolution.profile.id} missing needed tool(s): ${resolution.missingNeedsTools.join(', ')}`,
    resolution.profile,
    resolution.missingNeedsTools
  )
}

export function activateWorkflowTools(pi: ExtensionAPI, profile: WorkflowProfile): WorkflowToolActivation {
  const allToolNames = pi.getAllTools().map((tool) => tool.name)
  const previousActiveTools = pi.getActiveTools()
  const resolution = resolveWorkflowTools(profile, allToolNames, previousActiveTools)
  assertNeedsToolsPresent(resolution)

  try {
    pi.setActiveTools([...resolution.nextActiveTools])
  } catch (error) {
    try {
      pi.setActiveTools([...resolution.previousActiveTools])
    } catch {
      // Caller escalates unsafe-reset notice. Preserve original activation error.
    }
    throw new WorkflowToolActivationError(
      `${profile.id} failed to set active tools: ${formatError(error)}`,
      resolution,
      profile.toolAccess.needsTools
    )
  }

  const activeAfterSet = pi.getActiveTools()
  const active = new Set(activeAfterSet)
  const missingAfterSet = profile.toolAccess.needsTools.filter((name) => !active.has(name))
  if (missingAfterSet.length > 0) {
    try {
      pi.setActiveTools([...resolution.previousActiveTools])
    } catch {
      // Caller escalates unsafe-reset notice. Preserve original activation error.
    }
    throw new WorkflowToolActivationError(
      `${profile.id} failed to activate needed tool(s): ${missingAfterSet.join(', ')}`,
      resolution,
      missingAfterSet
    )
  }

  return { ...resolution, activeAfterSet: unique(activeAfterSet) }
}

export function restoreWorkflowTools(
  pi: ExtensionAPI,
  activation: Pick<WorkflowToolActivation, 'previousActiveTools'>
): readonly string[] {
  const expected = unique(activation.previousActiveTools)
  pi.setActiveTools([...expected])
  const actual = unique(pi.getActiveTools())
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.filter((name) => !actualSet.has(name))
  const extra = actual.filter((name) => !expectedSet.has(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new WorkflowToolRestoreError(
      `Failed to restore active tools. Missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`,
      expected,
      actual
    )
  }
  return actual
}

export function missingNeedsToolNames(profile: WorkflowProfile, allToolNames: readonly string[]): readonly string[] {
  const all = new Set(allToolNames)
  return profile.toolAccess.needsTools.filter((name) => !all.has(name))
}

export function activeToolNamesForProfile(
  profile: WorkflowProfile,
  allToolNames: readonly string[]
): readonly string[] {
  const all = new Set(allToolNames)
  const blocked = new Set(profile.toolAccess.blockedTools)
  const candidateTools = profile.toolAccess.onlyAllowedTools ?? getProfileToolNames(profile)
  return candidateTools.filter((name) => all.has(name) && !blocked.has(name))
}

function unique(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())]
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
