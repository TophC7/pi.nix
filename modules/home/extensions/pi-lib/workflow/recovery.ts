import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SAFE_DEFAULT_TOOLS, getWorkflowProfile } from "./profiles.ts";
import type { WorkflowId, WorkflowProfile } from "./types.ts";
import type { WorkflowMarker } from "./controller.ts";
import { workflowToolLeaseManager } from "./leases.ts";
import { restoreWorkflowTools } from "./tools.ts";
import { clearWorkflowUiStatus } from "./status.ts";

export type WorkflowRecoveryAction = "none" | "safe_reset" | "failed";

export interface WorkflowRecoveryResult {
	readonly action: WorkflowRecoveryAction;
	readonly marker?: WorkflowMarker;
	readonly activeTools?: readonly string[];
	readonly error?: string;
	readonly detail?: string;
}

let lastWorkflowRecovery: WorkflowRecoveryResult = { action: "none" };

export function getLastWorkflowRecovery(): WorkflowRecoveryResult {
	return lastWorkflowRecovery;
}

type CustomEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

export function recoverStaleWorkflow(pi: ExtensionAPI, ctx: ExtensionContext, markerType = "pi-workflow-state"): WorkflowRecoveryResult {
	const marker = latestWorkflowMarker(ctx, markerType);
	if (!marker || marker.status === "idle") return recordRecovery({ action: "none", marker });

	const profile = tryProfile(marker.profileId);
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const safeDefaults = profile?.recovery.safeDefaultTools ?? SAFE_DEFAULT_TOOLS;
	const targetTools = safeDefaults.filter((name) => allToolNames.has(name));

	try {
		workflowToolLeaseManager.clear();
		const activeTools = restoreWorkflowTools(pi, { previousActiveTools: targetTools });
		clearWorkflowStatus(ctx, profile);
		appendIdleMarker(pi, marker, markerType, "safe_reset", activeTools);
		notifyRecovery(ctx, marker, "safe_reset");
		return recordRecovery({
			action: "safe_reset",
			marker,
			activeTools,
			detail: `Safe-reset stale ${marker.profileId}:${marker.status}; old active-tool snapshot was not restored.`,
		});
	} catch (error) {
		const message = formatError(error);
		ctx.ui.notify(`Workflow recovery failed for ${marker.profileId}: ${message}`, "error");
		return recordRecovery({ action: "failed", marker, error: message });
	}
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

function clearWorkflowStatus(_ctx: ExtensionContext, profile: WorkflowProfile | undefined): void {
	if (!profile) return;
	clearWorkflowUiStatus(profile.statusKey);
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

function notifyRecovery(ctx: ExtensionContext, marker: WorkflowMarker, _action: WorkflowRecoveryAction): void {
	ctx.ui.notify(`Recovered stale ${marker.profileId} workflow with safe default tools; old active-tool snapshot was not restored.`, "warning");
}

function recordRecovery(result: WorkflowRecoveryResult): WorkflowRecoveryResult {
	lastWorkflowRecovery = result;
	return result;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
