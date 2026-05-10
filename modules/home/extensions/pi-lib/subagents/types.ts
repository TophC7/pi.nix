export type SubagentRunMode = "single" | "parallel" | "chain";

export type SubagentRunStatus = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

export type SubagentSlotStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

export type SubagentRerunDecision = "not-needed" | "pending" | "rerun-failed" | "continue-partial" | "cancelled";

export interface SubagentSlotPlan {
	id: string;
	agent: string;
	task: string;
	model?: string;
	thinking?: string;
	groupId?: string;
	groupIndex?: number;
	dependsOnSlotIds?: string[];
}

export interface SubagentRunRequest {
	id: string;
	mode: SubagentRunMode;
	label: string;
	slots: SubagentSlotPlan[];
	cwd: string;
	createdAt: number;
	context?: "fresh" | "fork";
	depth: number;
	maxDepth: number;
	parentSignal?: AbortSignal;
	outputPath?: string;
}

export interface SubagentUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	turns: number;
}

export interface SubagentDuration {
	startedAt: number;
	endedAt?: number;
	elapsedMs: number;
}

export interface SubagentTruncation {
	truncated: boolean;
	limitBytes?: number;
	limitLines?: number;
	originalBytes?: number;
	originalLines?: number;
	omittedBytes?: number;
	omittedLines?: number;
	note?: string;
	fullOutputPath?: string;
}

export interface SubagentOutputSnapshot {
	recentOutput: string;
	finalOutput?: string;
	truncation?: SubagentTruncation;
}

export interface SubagentToolSnapshot {
	id: string;
	name: string;
	status: "running" | "completed" | "failed" | "cancelled";
	args?: Record<string, unknown>;
	argsSummary?: string;
	startedAt?: number;
	endedAt?: number;
	elapsedMs?: number;
	preview?: string;
	previewTruncation?: SubagentTruncation;
	error?: string;
}

export type LiveLogEntry =
	| { kind: "turn_start"; turn: number; synthetic?: boolean }
	| { kind: "turn_end"; turn: number; inputTokens: number; outputTokens: number; synthetic?: boolean }
	| { kind: "tool_start"; toolName: string; args: Record<string, unknown> }
	| { kind: "tool_end"; toolName: string };

export interface SubagentExecutionEvent {
	timestamp: number;
	slotId: string;
	type: "slot-start" | "slot-output" | "tool-start" | "tool-end" | "slot-end" | "turn-start" | "turn-end" | "error" | "cancelled";
	text?: string;
	tool?: SubagentToolSnapshot;
	toolArgs?: Record<string, unknown>;
	turn?: number;
	usage?: SubagentUsage;
	synthetic?: boolean;
	error?: string;
}

export function mapEngineEventToLiveLog(event: SubagentExecutionEvent): LiveLogEntry[] {
	const turn = event.turn ?? 1;
	if (event.type === "turn-start") return [{ kind: "turn_start", turn, synthetic: event.synthetic }];
	if (event.type === "turn-end") {
		return [{
			kind: "turn_end",
			turn,
			inputTokens: event.usage?.inputTokens ?? 0,
			outputTokens: event.usage?.outputTokens ?? 0,
			synthetic: event.synthetic,
		}];
	}
	if (event.type === "slot-start") return [{ kind: "turn_start", turn, synthetic: true }];
	if (event.type === "slot-end") {
		return [{
			kind: "turn_end",
			turn,
			inputTokens: event.usage?.inputTokens ?? 0,
			outputTokens: event.usage?.outputTokens ?? 0,
			synthetic: true,
		}];
	}
	if (event.type === "tool-start" && event.tool) {
		return [{
			kind: "tool_start",
			toolName: event.tool.name,
			args: event.toolArgs ?? argsSummaryRecord(event.tool.argsSummary),
		}];
	}
	if (event.type === "tool-end" && event.tool) return [{ kind: "tool_end", toolName: event.tool.name }];
	return [];
}

export function mapSlotEventsToLiveLog(events: readonly SubagentExecutionEvent[], slotId?: string): LiveLogEntry[] {
	const slotEvents = events.filter((event) => !slotId || event.slotId === slotId);
	const hasExplicitTurnEvents = slotEvents.some((event) => event.type === "turn-start" || event.type === "turn-end");
	return slotEvents.flatMap((event) => {
		if (hasExplicitTurnEvents && (event.type === "slot-start" || event.type === "slot-end")) return [];
		return mapEngineEventToLiveLog(event);
	});
}

function argsSummaryRecord(summary: string | undefined): Record<string, unknown> {
	return summary ? { summary } : {};
}

export type SubagentRunUpdate =
	| { type: "run-start"; state: SubagentRunState }
	| { type: "slot-update"; runId: string; slot: SubagentSlotResult }
	| { type: "event"; runId: string; event: SubagentExecutionEvent }
	| { type: "run-end"; result: SubagentRunResult };

export interface SubagentSlotResult {
	id: string;
	agent: string;
	task: string;
	status: SubagentSlotStatus;
	model?: string;
	thinking?: string;
	currentTool?: string;
	toolCount: number;
	groupId?: string;
	groupIndex?: number;
	dependsOnSlotIds?: string[];
	tools: SubagentToolSnapshot[];
	usage: SubagentUsage;
	duration: SubagentDuration;
	output: SubagentOutputSnapshot;
	error?: string;
	cancelled?: boolean;
	outputPath?: string;
	attempt: number;
	previousSlotId?: string;
}

export interface SubagentRerunState {
	decision: SubagentRerunDecision;
	requestedAt?: number;
	failedSlotIds: string[];
	rerunSlotIds: string[];
	continuedWithPartialOutput: boolean;
	note?: string;
}

export interface SubagentRunResult {
	id: string;
	mode: SubagentRunMode;
	status: SubagentRunStatus;
	label: string;
	request: SubagentRunRequest;
	slots: SubagentSlotResult[];
	usage: SubagentUsage;
	duration: SubagentDuration;
	events: SubagentExecutionEvent[];
	finalText: string;
	error?: string;
	cancelled?: boolean;
	rerun: SubagentRerunState;
	truncation?: SubagentTruncation;
}

export interface SubagentRunState {
	id: string;
	mode: SubagentRunMode;
	status: SubagentRunStatus;
	label: string;
	request: SubagentRunRequest;
	slots: SubagentSlotResult[];
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	events: SubagentExecutionEvent[];
	rerun: SubagentRerunState;
	error?: string;
	cancelled?: boolean;
}

export function emptySubagentUsage(): SubagentUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		turns: 0,
	};
}

export function combineSubagentUsage(usages: readonly SubagentUsage[]): SubagentUsage {
	return usages.reduce<SubagentUsage>(
		(total, usage) => ({
			inputTokens: total.inputTokens + usage.inputTokens,
			outputTokens: total.outputTokens + usage.outputTokens,
			cacheReadTokens: (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
			cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
			costUsd: (total.costUsd ?? 0) + (usage.costUsd ?? 0),
			turns: total.turns + usage.turns,
		}),
		emptySubagentUsage(),
	);
}

export function buildParentFacingText(slots: readonly SubagentSlotResult[]): string {
	return slots
		.map((slot) => {
			const body = slot.output.finalOutput || slot.error || slot.output.recentOutput;
			return body.trim() ? `## ${slot.agent}\n\n${body.trim()}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
}
