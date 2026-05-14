import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { type WorkflowToolLease, workflowToolLeaseManager } from './leases.ts'
import { SANCTIONED_AUTHORING_WRITE_TOOLS, SWORM_CONFIG_MUTATION_TOOLS, SWORM_MUTATION_TOOLS } from './profiles.ts'

export interface SpecFinalizationApproval {
  readonly lease: WorkflowToolLease
  readonly approvalText: string
  readonly approvedAt: string
  readonly expiresOn: 'agent_end'
}

let activeSpecFinalization: SpecFinalizationApproval | undefined

export const SPEC_FINALIZATION_TOOLS = [
  ...SANCTIONED_AUTHORING_WRITE_TOOLS,
  ...SWORM_MUTATION_TOOLS,
  ...SWORM_CONFIG_MUTATION_TOOLS
] as const

export function beginApprovedSpecFinalization(
  pi: ExtensionAPI,
  approvalText: string,
  options: { ownerRunId?: string; token?: string } = {}
): SpecFinalizationApproval {
  if (!approvalText.trim()) throw new Error('Spec finalization requires recorded final user approval text.')
  if (activeSpecFinalization) return activeSpecFinalization
  const lease = workflowToolLeaseManager.acquire(pi, {
    profileId: 'spec-authoring',
    needsTools: [],
    blockedTools: [],
    ownerRunId: options.ownerRunId,
    token: options.token
  })
  activeSpecFinalization = {
    lease,
    approvalText,
    approvedAt: new Date().toISOString(),
    expiresOn: 'agent_end'
  }
  return activeSpecFinalization
}

export function endApprovedSpecFinalization(pi: ExtensionAPI, token: string, reason = 'spec_finalization_end'): void {
  if (!activeSpecFinalization || activeSpecFinalization.lease.token !== token) return
  try {
    workflowToolLeaseManager.release(pi, token, reason)
  } finally {
    activeSpecFinalization = undefined
  }
}

export function isSpecFinalizationActive(): boolean {
  return Boolean(activeSpecFinalization)
}

export function isSpecFinalizationTool(toolName: string | undefined): boolean {
  return Boolean(toolName && SPEC_FINALIZATION_TOOLS.includes(toolName as never))
}

export function getSpecFinalizationApproval(): SpecFinalizationApproval | undefined {
  return activeSpecFinalization
}

export function clearSpecFinalizationForTests(): void {
  activeSpecFinalization = undefined
}
