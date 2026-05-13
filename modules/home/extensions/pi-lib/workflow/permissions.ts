import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { workflowController } from "./controller.ts";
import { workflowToolLeaseManager, type WorkflowToolLease } from "./leases.ts";
import { getLastWorkflowRecovery, type WorkflowRecoveryResult } from "./recovery.ts";
import type { WorkflowId, WorkflowMutationPolicy, WorkflowPhase, WorkflowToolAccessPolicy } from "./types.ts";

export interface WorkflowPermissionsProfileSnapshot {
	readonly id: WorkflowId;
	readonly label: string;
	readonly phase: WorkflowPhase;
	readonly mutation: WorkflowMutationPolicy;
	readonly toolAccess: WorkflowToolAccessPolicy;
}

export interface WorkflowPermissionsSnapshot {
	readonly controllerStatus: string;
	readonly profile?: WorkflowPermissionsProfileSnapshot;
	readonly activeTools: readonly string[];
	readonly leases: readonly WorkflowToolLease[];
	readonly recovery: WorkflowRecoveryResult;
	readonly resetGuidance: readonly string[];
}

export function getWorkflowPermissionsSnapshot(pi: Pick<ExtensionAPI, "getActiveTools">): WorkflowPermissionsSnapshot {
	const run = workflowController.activeRun;
	const profile = run?.profile;
	const recovery = getLastWorkflowRecovery();
	return {
		controllerStatus: workflowController.status,
		profile: profile ? {
			id: profile.id,
			label: profile.label,
			phase: profile.phase,
			mutation: profile.mutation,
			toolAccess: profile.toolAccess,
		} : undefined,
		activeTools: pi.getActiveTools(),
		leases: workflowToolLeaseManager.activeLeases,
		recovery,
		resetGuidance: resetGuidance(workflowController.status, workflowToolLeaseManager.activeLeases, recovery),
	};
}

export function formatWorkflowPermissionsSnapshot(snapshot: WorkflowPermissionsSnapshot): string {
	const lines = [
		`Workflow permissions: ${snapshot.controllerStatus}`,
		snapshot.profile ? `Profile: ${snapshot.profile.id} (${snapshot.profile.label}, ${snapshot.profile.phase})` : "Profile: none",
		snapshot.profile ? `Mutation: files=${snapshot.profile.mutation.fileMutationTools}, shell=${snapshot.profile.mutation.mutatingShell}, implementation=${snapshot.profile.mutation.implementationWrites}` : undefined,
		snapshot.profile ? `Needs tools: ${formatList(snapshot.profile.toolAccess.needsTools)}` : undefined,
		snapshot.profile ? `Optional tools: ${formatList(snapshot.profile.toolAccess.optionalTools)}` : undefined,
		snapshot.profile ? `Blocked tools: ${formatList(snapshot.profile.toolAccess.blockedTools)}` : undefined,
		snapshot.profile ? `Only allowed: ${formatList(snapshot.profile.toolAccess.onlyAllowedTools ?? [])}` : undefined,
		`Active tools: ${formatList(snapshot.activeTools)}`,
		`Leases: ${snapshot.leases.length ? snapshot.leases.map((lease) => `${lease.token}:${lease.profileId}:${lease.status}`).join(", ") : "none"}`,
		`Recovery: ${snapshot.recovery.action}${snapshot.recovery.detail ? ` — ${snapshot.recovery.detail}` : ""}`,
		...restrictionExamples(snapshot),
		`Reset guidance: ${snapshot.resetGuidance.join(" ")}`,
	].filter((line): line is string => Boolean(line));
	return lines.join("\n");
}

function restrictionExamples(snapshot: WorkflowPermissionsSnapshot): readonly string[] {
	if (!snapshot.profile) return [];
	const examples: string[] = [];
	if (snapshot.profile.mutation.fileMutationTools === "block") examples.push("Example restriction: raw edit/write are blocked; use sanctioned save tools for authoring.");
	if (snapshot.profile.mutation.mutatingShell === "block") examples.push("Example restriction: mutating shell commands such as `rm foo` are blocked; read-only commands such as `git status` are allowed.");
	return examples;
}

function formatList(values: readonly string[]): string {
	return values.length ? values.join(", ") : "none";
}

function resetGuidance(status: string, leases: readonly WorkflowToolLease[], recovery: WorkflowRecoveryResult): readonly string[] {
	const guidance: string[] = [];
	if (status !== "idle") guidance.push("Use the owning workflow exit command if this state is expected; otherwise /reload will safe-reset stale markers on next start.");
	if (leases.some((lease) => lease.status === "restore_failed")) guidance.push("A lease restore failed; inspect lease restoreError and use /reload if active tools look wrong.");
	if (recovery.action === "safe_reset") guidance.push("Last startup safe-reset stale workflow state and did not restore old active-tool snapshots.");
	if (guidance.length === 0) guidance.push("No workflow reset needed.");
	return guidance;
}
