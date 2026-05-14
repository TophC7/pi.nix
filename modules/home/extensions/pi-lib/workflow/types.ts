export type WorkflowId =
  | 'plan-authoring'
  | 'spec-authoring'
  | 'spec-working'
  | 'plan-review-authoring'
  | 'cleanup'
  | 'handoff'

export type WorkflowOwner = 'spec' | 'plan-review' | 'cleanup' | 'git' | 'workflow'

export type WorkflowPhase = 'authoring' | 'implementation' | 'handoff'

export type WorkflowRestoreTarget = 'previous-active-tools' | 'safe-default-tools'

export type WorkflowFailureMode = 'restore-previous' | 'restore-previous-or-safe-default' | 'safe-default-only'

export type WorkflowMutationMode = 'allow' | 'block'

export type WorkflowLeaseLifetime = 'workflow-run' | 'operation' | 'agent-turn' | 'none'

export type WorkflowStaleRecoveryAction = 'restore-previous-if-valid' | 'safe-reset'

export interface WorkflowToolAccessPolicy {
  /** Tools a workflow needs added when absent. */
  readonly needsTools: readonly string[]
  /** Tools useful to add when present, but not required for correctness. */
  readonly optionalTools: readonly string[]
  /** Tools policy denies even if active tools expose them. */
  readonly blockedTools: readonly string[]
  /** Exclusive allowlist, only for workflows that intentionally restrict tools. */
  readonly onlyAllowedTools?: readonly string[]
}

export interface WorkflowBashRule {
  readonly id: string
  readonly pattern: RegExp
  readonly reason: string
}

export interface WorkflowMutationPolicy {
  readonly fileMutationTools: WorkflowMutationMode
  readonly implementationWrites: WorkflowMutationMode
  readonly mutatingShell: WorkflowMutationMode
  readonly blockedTools: readonly string[]
  readonly blockedBash: readonly WorkflowBashRule[]
}

export interface WorkflowLeasePolicy {
  /** `workflow-run` preserves current behavior until operation/turn leases land. */
  readonly lifetime: WorkflowLeaseLifetime
  readonly normalExit: WorkflowRestoreTarget
  readonly failure: WorkflowFailureMode
  readonly cancellation: WorkflowFailureMode
  readonly safeDefaultTools: readonly string[]
}

export interface WorkflowRecoveryPolicy {
  readonly markerType: string
  readonly persistMarker: boolean
  readonly persistToolSnapshot: boolean
  readonly recoverOnSessionStart: boolean
  readonly staleAction: WorkflowStaleRecoveryAction
  readonly safeDefaultTools: readonly string[]
}

export interface WorkflowProfile {
  readonly id: WorkflowId
  readonly owner: WorkflowOwner
  readonly phase: WorkflowPhase
  readonly label: string
  readonly statusKey: string
  readonly toolAccess: WorkflowToolAccessPolicy
  readonly mutation: WorkflowMutationPolicy
  readonly lease: WorkflowLeasePolicy
  readonly recovery: WorkflowRecoveryPolicy
}
