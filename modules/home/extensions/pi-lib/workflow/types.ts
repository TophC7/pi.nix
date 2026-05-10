export type WorkflowId =
	| "plan-authoring"
	| "spec-authoring"
	| "spec-working"
	| "plan-review-authoring"
	| "cleanup"
	| "handoff";

export type WorkflowOwner = "spec" | "plan-review" | "cleanup" | "git" | "workflow";

export type WorkflowPhase = "authoring" | "implementation" | "handoff";

export type WorkflowRestoreTarget = "previous-active-tools" | "safe-default-tools";

export type WorkflowFailureMode = "restore-previous" | "restore-previous-or-safe-default" | "safe-default-only";

export interface WorkflowToolPolicy {
	readonly required: readonly string[];
	readonly optional: readonly string[];
	readonly blocked: readonly string[];
}

export interface WorkflowBashRule {
	readonly id: string;
	readonly pattern: RegExp;
	readonly reason: string;
}

export interface WorkflowSafetyPolicy {
	readonly blocksFileMutationTools: boolean;
	readonly allowsImplementationWrites: boolean;
	readonly blocksMutatingShell: boolean;
	readonly blockedBash: readonly WorkflowBashRule[];
}

export interface WorkflowRestorePolicy {
	readonly normalExit: WorkflowRestoreTarget;
	readonly failure: WorkflowFailureMode;
	readonly cancellation: WorkflowFailureMode;
	readonly safeDefaultTools: readonly string[];
}

export interface WorkflowPersistencePolicy {
	readonly markerType: string;
	readonly persistMarker: boolean;
	readonly persistToolSnapshot: boolean;
	readonly recoverOnSessionStart: boolean;
}

export interface WorkflowProfile {
	readonly id: WorkflowId;
	readonly owner: WorkflowOwner;
	readonly phase: WorkflowPhase;
	readonly label: string;
	readonly statusKey: string;
	readonly tools: WorkflowToolPolicy;
	readonly safety: WorkflowSafetyPolicy;
	readonly restore: WorkflowRestorePolicy;
	readonly persistence: WorkflowPersistencePolicy;
}
