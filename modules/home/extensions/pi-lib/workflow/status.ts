import { clearUiOwner, publishStatus, publishWidget } from "@pi/lib/ui";

export interface WorkflowUiStatus {
	readonly key: string;
	readonly status: string;
	readonly label: string;
	readonly detail?: string;
}

export function publishWorkflowUiStatus(status: WorkflowUiStatus): void {
	publishStatus({
		id: `${status.key}:status`,
		owner: status.key,
		text: status.status,
		priority: "high",
		order: 20,
		staleAfterMs: 10 * 60_000,
	});
	publishWidget({
		id: `${status.key}:widget`,
		owner: status.key,
		placement: "aboveEditor",
		content: [status.label, status.detail ?? `Status: ${status.status}`],
		priority: "high",
		order: 20,
		staleAfterMs: 10 * 60_000,
	});
}

export function clearWorkflowUiStatus(key: string): void {
	clearUiOwner(key);
}
