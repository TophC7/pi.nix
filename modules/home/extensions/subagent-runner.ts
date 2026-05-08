import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const REQUEST_EVENT = "subagent:slash:request";
const STARTED_EVENT = "subagent:slash:started";
const RESPONSE_EVENT = "subagent:slash:response";
const UPDATE_EVENT = "subagent:slash:update";
const START_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 2 * 60 * 60_000;
const TERMINAL_STATE_TTL_MS = 5 * 60_000;

const PROGRESS_MSG_TYPE = "shared-subagent-runner-progress";

export type SubagentParams = Record<string, unknown>;

type TextPart = { type?: string; text?: string };
export type SubagentResponse = {
	requestId: string;
	result?: {
		content?: unknown;
		details?: {
			results?: Array<{
				agent?: string;
				finalOutput?: string;
				error?: string;
				exitCode?: number;
				messages?: unknown[];
			}>;
		};
	};
	isError?: boolean;
	errorText?: string;
};

type SubagentUpdate = {
	requestId?: string;
	currentTool?: string;
	toolCount?: number;
	progress?: Array<{
		agent?: string;
		currentTool?: string;
		toolCount?: number;
		status?: string;
	}>;
};

type AgentStatus = "pending" | "running" | "done" | "error";
type RunStatus = "running" | "done" | "error";

interface AgentSlot {
	name: string;
	status: AgentStatus;
	toolCount?: number;
	currentTool?: string;
}

interface RunnerState {
	requestId: string;
	label: string;
	status: RunStatus;
	agents: AgentSlot[];
	startedAt: number;
	endedAt?: number;
	errorText?: string;
}

const liveStates = new Map<string, RunnerState>();
let rendererRegistered = false;

function ensureRendererRegistered(pi: ExtensionAPI): void {
	if (rendererRegistered) return;
	rendererRegistered = true;
	pi.registerMessageRenderer<{ requestId?: string }>(PROGRESS_MSG_TYPE, (message, _options, theme) => {
		const requestId = (message.details as { requestId?: string } | undefined)?.requestId;
		if (!requestId) return undefined;
		const fg = (name: string, text: string): string => (theme as { fg: (n: string, t: string) => string }).fg(name, text);
		const bold = (text: string): string => (theme as { bold: (t: string) => string }).bold(text);
		return {
			invalidate() {},
			render(_width: number): string[] {
				const state = liveStates.get(requestId);
				if (!state) {
					const fallback = typeof message.content === "string" ? message.content : "";
					return fallback ? fallback.split("\n") : [fg("muted", "(subagent run completed)")];
				}
				const lines: string[] = [];
				lines.push(`${runIcon(fg, state.status)} ${bold(state.label)}${fg("muted", ` · ${runDuration(state)}`)}`);
				for (const slot of state.agents) {
					const meta: string[] = [];
					if (typeof slot.toolCount === "number") meta.push(`${slot.toolCount} tools`);
					if (slot.currentTool) meta.push(slot.currentTool);
					const tail = meta.length > 0 ? fg("muted", ` · ${meta.join(" · ")}`) : "";
					lines.push(`  ${agentIcon(fg, slot.status)} ${slot.name}${tail}`);
				}
				if (state.errorText) lines.push(`  ${fg("error", state.errorText)}`);
				return lines;
			},
		};
	});
}

function runIcon(fg: (name: string, text: string) => string, status: RunStatus): string {
	if (status === "running") return fg("warning", "⏵");
	if (status === "done") return fg("success", "✓");
	return fg("error", "✗");
}

function agentIcon(fg: (name: string, text: string) => string, status: AgentStatus): string {
	if (status === "running") return fg("warning", "⏵");
	if (status === "done") return fg("success", "✓");
	if (status === "error") return fg("error", "✗");
	return fg("muted", "·");
}

function runDuration(state: RunnerState): string {
	const end = state.endedAt ?? Date.now();
	const ms = Math.max(0, end - state.startedAt);
	if (ms < 1000) return `${ms}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	return `${m}m${rs.toString().padStart(2, "0")}s`;
}

function buildInitialAgents(params: SubagentParams): AgentSlot[] {
	const slots: AgentSlot[] = [];
	const tasks = (params as { tasks?: Array<{ agent?: string }> }).tasks;
	if (Array.isArray(tasks) && tasks.length > 0) {
		for (const task of tasks) slots.push({ name: task.agent ?? "(unknown)", status: "pending" });
		return slots;
	}
	const chain = (params as { chain?: Array<{ agent?: string; parallel?: Array<{ agent?: string }> }> }).chain;
	if (Array.isArray(chain) && chain.length > 0) {
		for (const step of chain) {
			if (Array.isArray(step.parallel)) {
				for (const sub of step.parallel) slots.push({ name: sub.agent ?? "(unknown)", status: "pending" });
			} else {
				slots.push({ name: step.agent ?? "(unknown)", status: "pending" });
			}
		}
		return slots;
	}
	const agent = (params as { agent?: string }).agent;
	if (typeof agent === "string") slots.push({ name: agent, status: "pending" });
	return slots;
}

function subscribe(pi: ExtensionAPI, event: string, handler: (data: unknown) => void): () => void {
	const unsubscribe = pi.events.on(event, handler);
	if (typeof unsubscribe === "function") return unsubscribe;
	throw new Error(`pi.events.on('${event}') did not return an unsubscribe function; refusing to leak listeners.`);
}

export async function runSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	params: SubagentParams,
	label: string,
	statusKey: string,
): Promise<SubagentResponse> {
	const requestId = randomUUID();
	ctx.ui.setStatus(statusKey, `${label}: starting`);
	ensureRendererRegistered(pi);

	const state: RunnerState = {
		requestId,
		label,
		status: "running",
		agents: buildInitialAgents(params),
		startedAt: Date.now(),
	};
	liveStates.set(requestId, state);

	const requestRedraw = () => {
		try {
			ctx.ui.requestRender?.();
		} catch {
			// Best effort: requestRender can throw if context torn down.
		}
	};
	const scheduleStateCleanup = () => {
		const timeout = setTimeout(() => liveStates.delete(requestId), TERMINAL_STATE_TTL_MS);
		(timeout as { unref?: () => void }).unref?.();
	};

	if (ctx.hasUI) {
		const fallbackContent = state.agents.length > 0
			? `${label}: ${state.agents.map((slot) => slot.name).join(", ")}`
			: `${label}: dispatching`;
		try {
			pi.sendMessage({
				customType: PROGRESS_MSG_TYPE,
				content: fallbackContent,
				display: true,
				details: { requestId },
			});
		} catch {
			// Best effort: progress card is decorative.
		}
	}

	return new Promise<SubagentResponse>((resolve, reject) => {
		let done = false;
		let unsubStarted: () => void = () => {};
		let unsubUpdate: () => void = () => {};
		let unsubResponse: () => void = () => {};
		const signal: AbortSignal | undefined = ctx.signal;
		let abortAttached = false;

		const startTimeout = setTimeout(() => {
			fail(`pi-subagents bridge did not start within ${START_TIMEOUT_MS / 1000}s. Is pi-subagents installed and loaded?`);
		}, START_TIMEOUT_MS);
		const responseTimeout = setTimeout(() => {
			fail(`Subagent ${label} did not finish within ${RESPONSE_TIMEOUT_MS / 60_000}m.`);
		}, RESPONSE_TIMEOUT_MS);
		const onAbort = () => fail(`Subagent ${label} cancelled.`);

		function finish(next: () => void) {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			clearTimeout(responseTimeout);
			if (abortAttached) {
				try {
					signal?.removeEventListener("abort", onAbort);
				} catch {
					// signal may have been disposed; safe to ignore.
				}
			}
			unsubStarted();
			unsubUpdate();
			unsubResponse();
			ctx.ui.setStatus(statusKey, undefined);
			next();
		}

		function fail(message: string, error: unknown = new Error(message)) {
			markRunFailure(state, message);
			requestRedraw();
			scheduleStateCleanup();
			finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		}

		if (signal?.aborted) {
			fail(`Subagent ${label} cancelled.`);
			return;
		}
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			abortAttached = true;
		}

		const onStarted = (data: unknown) => {
			if (!isMatching(data, requestId)) return;
			clearTimeout(startTimeout);
			ctx.ui.setStatus(statusKey, `${label}: running`);
			for (const slot of state.agents) {
				if (slot.status === "pending") slot.status = "running";
			}
			requestRedraw();
		};

		const onUpdate = (data: unknown) => {
			if (!isMatching(data, requestId)) return;
			const update = data as SubagentUpdate;
			if (Array.isArray(update.progress) && update.progress.length > 0) {
				const usedSlots = new Set<AgentSlot>();
				for (let i = 0; i < update.progress.length; i++) {
					const entry = update.progress[i];
					const indexSlot = state.agents[i];
					const namedSlot = typeof entry?.agent === "string"
						? state.agents.find((agent) => agent.name === entry.agent && !usedSlots.has(agent))
						: undefined;
					const slot = namedSlot ?? indexSlot;
					if (!entry || !slot) continue;
					usedSlots.add(slot);
					if (entry.currentTool !== undefined) slot.currentTool = entry.currentTool;
					if (typeof entry.toolCount === "number") slot.toolCount = entry.toolCount;
					slot.status = mapAgentStatus(entry.status, slot.status);
				}
			} else if (state.agents.length > 0) {
				const slot = state.agents[0];
				if (slot) {
					if (update.currentTool !== undefined) slot.currentTool = update.currentTool;
					if (typeof update.toolCount === "number") slot.toolCount = update.toolCount;
					if (slot.status === "pending") slot.status = "running";
				}
			}
			const progress = update.progress?.find((entry) => entry.currentTool || entry.status) ?? update.progress?.[0];
			const tool = update.currentTool ?? progress?.currentTool;
			const count = update.toolCount ?? progress?.toolCount;
			const countText = typeof count === "number" ? `${count} tools` : "running";
			ctx.ui.setStatus(statusKey, `${label}: ${countText}${tool ? ` · ${tool}` : ""}`);
			requestRedraw();
		};

		const onResponse = (data: unknown) => {
			if (!isMatching(data, requestId)) return;
			const response = data as SubagentResponse;
			finish(() => {
				if (response.isError) {
					const text = response.errorText || extractSubagentText(response) || "Subagent run failed.";
					markRunFailure(state, text);
					requestRedraw();
					scheduleStateCleanup();
					reject(new Error(text));
					return;
				}
				const failure = firstSubagentFailure(response);
				if (failure) {
					markRunFailure(state, failure);
					requestRedraw();
					scheduleStateCleanup();
					reject(new Error(failure));
					return;
				}
				const text = extractSubagentText(response);
				if (!text) {
					markRunFailure(state, `Subagent ${label} produced no output.`);
					requestRedraw();
					scheduleStateCleanup();
					reject(new Error(`Subagent ${label} produced no output.`));
					return;
				}
				markRunSuccess(state);
				requestRedraw();
				scheduleStateCleanup();
				resolve(response);
			});
		};

		try {
			unsubStarted = subscribe(pi, STARTED_EVENT, onStarted);
			unsubUpdate = subscribe(pi, UPDATE_EVENT, onUpdate);
			unsubResponse = subscribe(pi, RESPONSE_EVENT, onResponse);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), error);
			return;
		}

		try {
			pi.events.emit(REQUEST_EVENT, { requestId, params });
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), error);
		}
	});
}

function mapAgentStatus(remote: string | undefined, current: AgentStatus): AgentStatus {
	if (remote === "completed") return "done";
	if (remote === "failed") return "error";
	if (remote === "running") return "running";
	if (remote === "pending") return current === "pending" ? "pending" : current;
	return current;
}

function markRunSuccess(state: RunnerState): void {
	state.status = "done";
	state.endedAt = Date.now();
	for (const slot of state.agents) {
		if (slot.status !== "error") slot.status = "done";
	}
}

function markRunFailure(state: RunnerState, message: string): void {
	state.status = "error";
	state.endedAt = Date.now();
	state.errorText = message;
	for (const slot of state.agents) {
		if (slot.status === "running" || slot.status === "pending") slot.status = "error";
	}
}

export function extractSubagentText(response: SubagentResponse): string {
	const contentText = textFromContent(response.result?.content);
	const resultTexts = response.result?.details?.results
		?.map((result) => {
			const body = result.finalOutput || textFromMessages(result.messages) || result.error || "";
			return body.trim() ? `## ${result.agent ?? "subagent"}\n\n${body.trim()}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
	return (resultTexts || contentText || response.errorText || "").trim();
}

function isMatching(data: unknown, requestId: string): boolean {
	return Boolean(data && typeof data === "object" && (data as { requestId?: unknown }).requestId === requestId);
}

function firstSubagentFailure(response: SubagentResponse): string | undefined {
	const results = response.result?.details?.results;
	if (!Array.isArray(results)) return undefined;
	const failed = results.find((result) => result?.error || (typeof result?.exitCode === "number" && result.exitCode !== 0));
	if (!failed) return undefined;
	const agent = failed.agent ?? "subagent";
	const reason = failed.error || (typeof failed.exitCode === "number" ? `exit code ${failed.exitCode}` : "failed");
	return `${agent} failed: ${reason}`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: TextPart) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

function textFromMessages(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	return messages
		.map((message) => {
			if (!message || typeof message !== "object") return "";
			return textFromContent((message as { content?: unknown }).content);
		})
		.filter(Boolean)
		.join("\n\n")
		.trim();
}
