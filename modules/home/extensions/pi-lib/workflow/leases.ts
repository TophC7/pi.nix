import { randomUUID } from 'node:crypto'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { getWorkflowProfile } from './profiles.ts'
import { activateWorkflowTools, type WorkflowToolActivation, WorkflowToolRestoreError } from './tools.ts'
import type { WorkflowId, WorkflowProfile } from './types.ts'

export type WorkflowToolLeaseStatus = 'active' | 'release_deferred' | 'released' | 'restore_failed'

export type WorkflowToolLeaseReleaseStatus = 'released' | 'release_deferred' | 'already_released'

export interface WorkflowToolLeaseErrorDetails {
  readonly name: string
  readonly message: string
}

export interface WorkflowToolLease {
  readonly token: string
  readonly ownerRunId?: string
  readonly profileId: WorkflowId
  readonly acquiredAt: string
  readonly releasedAt?: string
  readonly status: WorkflowToolLeaseStatus
  readonly releaseReason?: string
  readonly capturedActiveTools: readonly string[]
  readonly activeTools: readonly string[]
  readonly restoreError?: WorkflowToolLeaseErrorDetails
}

export interface WorkflowToolLeaseAcquireOptions {
  readonly ownerRunId?: string
  readonly token?: string
}

export interface WorkflowToolLeaseDirectRequest extends WorkflowToolLeaseAcquireOptions {
  readonly profileId?: WorkflowId
  readonly needsTools: readonly string[]
  readonly optionalTools?: readonly string[]
  readonly blockedTools?: readonly string[]
  readonly onlyAllowedTools?: readonly string[]
}

export type WorkflowToolLeaseTarget = WorkflowProfile | WorkflowToolLeaseDirectRequest

export interface WorkflowToolLeaseReleaseResult {
  readonly token: string
  readonly status: WorkflowToolLeaseReleaseStatus
  readonly activeTools: readonly string[]
  readonly deferredBy?: string
}

interface WorkflowToolLeaseRecord {
  token: string
  ownerRunId?: string
  profile: WorkflowProfile
  acquiredAt: string
  releasedAt?: string
  status: WorkflowToolLeaseStatus
  releaseRequested: boolean
  releaseReason?: string
  activation: WorkflowToolActivation
  restoreError?: WorkflowToolLeaseErrorDetails
}

export class WorkflowToolLeaseRestoreError extends WorkflowToolRestoreError {
  constructor(
    readonly token: string,
    expectedActiveTools: readonly string[],
    actualActiveTools: readonly string[]
  ) {
    super(
      `Failed to restore active tools for lease ${token}. Missing: ${missing(expectedActiveTools, actualActiveTools).join(', ') || 'none'}; extra: ${missing(actualActiveTools, expectedActiveTools).join(', ') || 'none'}`,
      expectedActiveTools,
      actualActiveTools
    )
    this.name = 'WorkflowToolLeaseRestoreError'
  }
}

export class WorkflowToolLeaseManager {
  private readonly records: WorkflowToolLeaseRecord[] = []

  get activeLeases(): readonly WorkflowToolLease[] {
    return this.records.map(snapshotLease)
  }

  acquire(
    pi: ExtensionAPI,
    target: WorkflowToolLeaseTarget,
    options: WorkflowToolLeaseAcquireOptions = {}
  ): WorkflowToolLease {
    const profile = isWorkflowProfile(target) ? target : profileForLeaseRequest(target)
    const ownerRunId = isWorkflowProfile(target) ? options.ownerRunId : (target.ownerRunId ?? options.ownerRunId)
    const token = isWorkflowProfile(target) ? options.token : (target.token ?? options.token)
    const activation = activateWorkflowTools(pi, profile)
    const record: WorkflowToolLeaseRecord = {
      token: token ?? randomUUID(),
      ownerRunId,
      profile,
      acquiredAt: new Date().toISOString(),
      status: 'active',
      releaseRequested: false,
      activation
    }
    this.records.push(record)
    return snapshotLease(record)
  }

  release(pi: ExtensionAPI, token: string, reason = 'release'): WorkflowToolLeaseReleaseResult {
    const index = this.records.findIndex((record) => record.token === token)
    if (index < 0)
      return {
        token,
        status: 'already_released',
        activeTools: pi.getActiveTools()
      }

    const record = this.records[index]
    if (record.releaseRequested)
      return {
        token,
        status: 'already_released',
        activeTools: pi.getActiveTools()
      }

    record.releaseRequested = true
    record.releaseReason = reason
    record.releasedAt = new Date().toISOString()

    if (index !== this.records.length - 1) {
      record.status = 'release_deferred'
      return {
        token,
        status: 'release_deferred',
        activeTools: pi.getActiveTools(),
        deferredBy: this.records[this.records.length - 1].token
      }
    }

    return this.drainReleasedLeases(pi, token)
  }

  clear(): void {
    this.records.length = 0
  }

  private drainReleasedLeases(pi: ExtensionAPI, token: string): WorkflowToolLeaseReleaseResult {
    const released: WorkflowToolLeaseRecord[] = []
    while (this.records.at(-1)?.releaseRequested) {
      const record = this.records.pop()
      if (!record) break
      released.push(record)
    }
    if (released.length === 0)
      return {
        token,
        status: 'already_released',
        activeTools: pi.getActiveTools()
      }

    const outermost = released.at(-1)!
    const expected = [...outermost.activation.previousActiveTools]
    pi.setActiveTools(expected)
    const actual = pi.getActiveTools()
    const missingTools = missing(expected, actual)
    const extraTools = missing(actual, expected)
    if (missingTools.length > 0 || extraTools.length > 0) {
      const error = new WorkflowToolLeaseRestoreError(outermost.token, expected, actual)
      for (const record of released) {
        record.status = 'restore_failed'
        record.restoreError = errorDetails(error)
      }
      this.records.push(...released.reverse())
      throw error
    }

    for (const record of released) record.status = 'released'
    return { token, status: 'released', activeTools: actual }
  }
}

export const workflowToolLeaseManager = new WorkflowToolLeaseManager()

export async function withWorkflowToolLease<T>(
  pi: ExtensionAPI,
  target: WorkflowToolLeaseTarget,
  operation: (lease: WorkflowToolLease) => T | Promise<T>
): Promise<T> {
  const lease = workflowToolLeaseManager.acquire(pi, target)
  try {
    return await operation(lease)
  } finally {
    workflowToolLeaseManager.release(pi, lease.token, 'withWorkflowToolLease.finally')
  }
}

function profileForLeaseRequest(request: WorkflowToolLeaseDirectRequest): WorkflowProfile {
  const base = getWorkflowProfile(request.profileId ?? 'handoff')
  return {
    ...base,
    toolAccess: {
      needsTools: request.needsTools,
      optionalTools: request.optionalTools ?? [],
      blockedTools: request.blockedTools ?? [],
      onlyAllowedTools: request.onlyAllowedTools
    }
  }
}

function isWorkflowProfile(value: WorkflowToolLeaseTarget): value is WorkflowProfile {
  return 'toolAccess' in value && 'mutation' in value && 'lease' in value && 'recovery' in value
}

function snapshotLease(record: WorkflowToolLeaseRecord): WorkflowToolLease {
  return {
    token: record.token,
    ownerRunId: record.ownerRunId,
    profileId: record.profile.id,
    acquiredAt: record.acquiredAt,
    releasedAt: record.releasedAt,
    status: record.status,
    releaseReason: record.releaseReason,
    capturedActiveTools: [...record.activation.previousActiveTools],
    activeTools: [...record.activation.activeAfterSet],
    restoreError: record.restoreError
  }
}

function missing(expected: readonly string[], actual: readonly string[]): readonly string[] {
  const actualSet = new Set(actual)
  return expected.filter((name) => !actualSet.has(name))
}

function errorDetails(error: unknown): WorkflowToolLeaseErrorDetails {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}
