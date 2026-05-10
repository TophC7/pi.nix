import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SAFE_DEFAULT_TOOLS, getWorkflowProfile } from "./profiles.ts";
import type { WorkflowId, WorkflowProfile } from "./types.ts";
import type { WorkflowMarker } from "./controller.ts";
import { activeToolNamesForProfile, restoreWorkflowTools } from "./tools.ts";

export type WorkflowRecoveryAction = "none" | "migrated_awaiting_confirmation" | "restored_previous" | "safe_reset" | "failed";

export interface WorkflowRecoveryResult {
	readonly action: WorkflowRecoveryAction;
	readonly marker?: WorkflowMarker;
	readonly activeTools?: readonly string[];
	readonly error?: string;
}

type CustomEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

export function recoverStaleWorkflow(pi: ExtensionAPI, ctx: ExtensionContext, markerType = "pi-workflow-state"): WorkflowRecoveryResult {
	const marker = latestWorkflowMarker(ctx, markerType);
	if (!marker || marker.status === "idle") return { action: "none" };

	const profile = tryProfile(marker.profileId);
	if (marker.status === "handoff_pending") return migrateHandoffPending(pi, ctx, marker, profile, markerType);

	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const previousTools = marker.previousActiveTools?.filter((name) => allToolNames.has(name));
	const canRestorePrevious = Boolean(previousTools && previousTools.length === marker.previousActiveTools?.length);
	const targetTools = canRestorePrevious ? previousTools! : SAFE_DEFAULT_TOOLS.filter((name) => allToolNames.has(name));
	const action: WorkflowRecoveryAction = canRestorePrevious ? "restored_previous" : "safe_reset";

	try {
		const activeTools = restoreWorkflowTools(pi, { previousActiveTools: targetTools });
		clearWorkflowStatus(ctx, profile);
		appendIdleMarker(pi, marker, markerType, action, activeTools);
		notifyRecovery(ctx, marker, action);
		return { action, marker, activeTools };
	} catch (error) {
		const message = formatError(error);
		ctx.ui.notify(`Workflow recovery failed for ${marker.profileId}: ${message}`, "error");
		return { action: "failed", marker, error: message };
	}
}

function migrateHandoffPending(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	marker: WorkflowMarker,
	profile: WorkflowProfile | undefined,
	markerType: string,
): WorkflowRecoveryResult {
	try {
		const activeTools = restoreAwaitingConfirmationTools(pi, marker, profile);
		if (profile) renderAwaitingConfirmation(ctx, profile);
		const migrated: WorkflowMarker = {
			...marker,
			status: "awaiting_confirmation",
			activeTools,
			reason: "migrated_from_handoff_pending",
			timestamp: new Date().toISOString(),
		};
		pi.appendEntry(markerType, migrated);
		ctx.ui.notify("Resumed workflow with migrated status; original continuation was not re-fired", "info");
		return { action: "migrated_awaiting_confirmation", marker: migrated, activeTools };
	} catch (error) {
		const message = formatError(error);
		ctx.ui.notify(`Workflow handoff_pending migration failed for ${marker.profileId}: ${message}`, "error");
		return { action: "failed", marker, error: message };
	}
}

function restoreAwaitingConfirmationTools(
	pi: ExtensionAPI,
	marker: WorkflowMarker,
	profile: WorkflowProfile | undefined,
): readonly string[] {
	const allToolNames = pi.getAllTools().map((tool) => tool.name);
	const all = new Set(allToolNames);
	const markerTools = marker.activeTools?.filter((name) => all.has(name));
	const targetTools = markerTools && markerTools.length === marker.activeTools?.length
		? markerTools
		: profile
			? activeToolNamesForProfile(profile, allToolNames)
			: SAFE_DEFAULT_TOOLS.filter((name) => all.has(name));
	pi.setActiveTools(targetTools);
	return pi.getActiveTools();
}

function renderAwaitingConfirmation(ctx: ExtensionContext, profile: WorkflowProfile): void {
	ctx.ui.setStatus(profile.statusKey, `${profile.id}:awaiting_confirmation`);
	ctx.ui.setWidget(profile.statusKey, [`Pi workflow: ${profile.label}`, "Status: awaiting_confirmation"]);
}

export function latestWorkflowMarker(ctx: ExtensionContext, markerType = "pi-workflow-state"): WorkflowMarker | undefined {
	const entries = ctx.sessionManager.getEntries() as CustomEntry[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== markerType) continue;
		if (isWorkflowMarker(entry.data)) return entry.data;
	}
	return undefined;
}

function isWorkflowMarker(value: unknown): value is WorkflowMarker {
	if (!value || typeof value !== "object") return false;
	const marker = value as Partial<WorkflowMarker>;
	return typeof marker.runId === "string"
		&& typeof marker.profileId === "string"
		&& isWorkflowStatus(marker.status)
		&& typeof marker.timestamp === "string";
}

function isWorkflowStatus(value: unknown): value is WorkflowMarker["status"] {
	return value === "idle"
		|| value === "entering"
		|| value === "active"
		|| value === "awaiting_confirmation"
		|| value === "continuation_queued"
		|| value === "manual_pending"
		|| value === "handoff_pending"
		|| value === "exiting"
		|| value === "failed_resetting";
}

function tryProfile(id: WorkflowId): WorkflowProfile | undefined {
	try {
		return getWorkflowProfile(id);
	} catch {
		return undefined;
	}
}

function clearWorkflowStatus(ctx: ExtensionContext, profile: WorkflowProfile | undefined): void {
	if (!profile) return;
	ctx.ui.setStatus(profile.statusKey, undefined);
	ctx.ui.setWidget(profile.statusKey, undefined);
}

function appendIdleMarker(
	pi: ExtensionAPI,
	marker: WorkflowMarker,
	markerType: string,
	reason: WorkflowRecoveryAction,
	activeTools: readonly string[],
): void {
	pi.appendEntry(markerType, {
		runId: marker.runId,
		profileId: marker.profileId,
		status: "idle",
		previousActiveTools: marker.previousActiveTools,
		activeTools,
		reason,
		timestamp: new Date().toISOString(),
	} satisfies WorkflowMarker);
}

function notifyRecovery(ctx: ExtensionContext, marker: WorkflowMarker, action: WorkflowRecoveryAction): void {
	if (action === "restored_previous") {
		ctx.ui.notify(`Recovered stale ${marker.profileId} workflow; restored previous active tools.`, "warning");
		return;
	}
	ctx.ui.notify(`Recovered stale ${marker.profileId} workflow with safe default tools; exact prior snapshot unavailable.`, "warning");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
