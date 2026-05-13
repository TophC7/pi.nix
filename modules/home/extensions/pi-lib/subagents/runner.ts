import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./discovery.ts";
import { runSubagents } from "./engine.ts";
import { buildCappedParentFacingText } from "./output.ts";
import { spinnerFrameForTick, SUBAGENT_ANIMATION_MS } from "./render-helpers.ts";
import { createSubagentMessageRenderer, SUBAGENT_RUN_MESSAGE_TYPE } from "./render.ts";
import { clearUiOwner, publishStatus } from "../ui/index.ts";
import { buildRunRequest, normalizeSubagentRequest } from "./request.ts";
import { combineSubagentUsage, mapEngineEventToLiveLog, type SubagentRunRequest, type SubagentRunResult, type SubagentRunState, type SubagentRunUpdate } from "./types.ts";

const TERMINAL_STATE_TTL_MS = 5 * 60_000;

export type SubagentParams = Record<string, unknown>;

export type SubagentResponse = {
	requestId: string;
	result?: {
		content?: Array<{ type: "text"; text: string }>;
		details?: {
			run?: SubagentRunResult;
			results?: Array<{
				agent?: string;
				finalOutput?: string;
				error?: string;
				exitCode?: number;
			}>;
		};
	};
	isError?: boolean;
	errorText?: string;
};

type SubagentRenderable = SubagentRunState | SubagentRunResult;

const liveRuns = new Map<string, SubagentRenderable>();
const liveMessageAnimationTimers = new Map<string, ReturnType<typeof setInterval>>();
let rendererRegistered = false;

function ensureRendererRegistered(pi: ExtensionAPI): void {
	if (rendererRegistered) return;
	rendererRegistered = true;
	pi.registerMessageRenderer(SUBAGENT_RUN_MESSAGE_TYPE, createSubagentMessageRenderer(liveRuns));
}

const REDRAW_THROTTLE_MS = 60;
const SUBAGENT_STATUS_TTL_MS = 5 * 60_000;

function runHasRunningSlot(run: SubagentRenderable | undefined): boolean {
	return Boolean(run && "slots" in run && run.slots.some((slot) => slot.status === "running"));
}

function syncLiveMessageAnimation(runId: string, requestRedraw: () => void): void {
	if (!runHasRunningSlot(liveRuns.get(runId))) {
		stopLiveMessageAnimation(runId);
		return;
	}
	if (liveMessageAnimationTimers.has(runId)) return;
	const timer = setInterval(() => {
		if (!runHasRunningSlot(liveRuns.get(runId))) {
			stopLiveMessageAnimation(runId);
			return;
		}
		requestRedraw();
	}, SUBAGENT_ANIMATION_MS);
	(timer as { unref?: () => void }).unref?.();
	liveMessageAnimationTimers.set(runId, timer);
}

function stopLiveMessageAnimation(runId: string): void {
	const timer = liveMessageAnimationTimers.get(runId);
	if (!timer) return;
	clearInterval(timer);
	liveMessageAnimationTimers.delete(runId);
}

function publishSubagentStatus(statusKey: string, text: string, animated = false): void {
	publishStatus({
		id: `${statusKey}:status`,
		owner: statusKey,
		text: animated ? ({ tick }) => `${spinnerFrameForTick(tick)} ${text}` : text,
		priority: "normal",
		order: 40,
		staleAfterMs: SUBAGENT_STATUS_TTL_MS,
		schedule: animated ? { animateEveryMs: SUBAGENT_ANIMATION_MS } : undefined,
	});
}

function clearSubagentStatus(statusKey: string): void {
	clearUiOwner(statusKey);
}

function throttledRedraw(ctx: ExtensionCommandContext): () => void {
	let pending = false;
	let scheduled = false;
	return () => {
		pending = true;
		if (scheduled) return;
		scheduled = true;
		const timeout = setTimeout(() => {
			scheduled = false;
			if (!pending) return;
			pending = false;
			try {
				(ctx.ui as { requestRender?: () => void }).requestRender?.();
			} catch {
				// UI context may be gone during cancellation/session switch.
			}
		}, REDRAW_THROTTLE_MS);
		(timeout as { unref?: () => void }).unref?.();
	};
}

export async function runSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	params: SubagentParams,
	label: string,
	statusKey: string,
): Promise<SubagentResponse> {
	ensureRendererRegistered(pi);
	const normalization = normalizeSubagentRequest(params, { defaultLabel: label });
	if (!normalization.ok) throw new Error(`Subagent ${label}: ${normalization.error}`);
	const request = buildRunRequest(normalization.request, { cwd: ctx.cwd, parentSignal: ctx.signal });
	if (request.slots.length === 0) throw new Error(`Subagent ${label} has no agents to run.`);

	publishSubagentStatus(statusKey, `${label}: starting`, true);
	const scheduleStateCleanup = () => {
		const timeout = setTimeout(() => {
			stopLiveMessageAnimation(request.id);
			liveRuns.delete(request.id);
		}, TERMINAL_STATE_TTL_MS);
		(timeout as { unref?: () => void }).unref?.();
	};
	const requestRedraw = throttledRedraw(ctx);

	if (ctx.hasUI) {
		pi.sendMessage({
			customType: SUBAGENT_RUN_MESSAGE_TYPE,
			content: `${label}: ${request.slots.map((slot) => slot.agent).join(", ")}`,
			display: true,
			details: { runId: request.id },
		});
	}

	try {
		const agents = discoverAgents({
			cwd: ctx.cwd,
			agentScope: normalization.request.agentScope,
			localPackagesDir: fileURLToPath(new URL("../..", import.meta.url)),
		});
		let result = await runSubagents(request, {
			agents,
			onUpdate: (update) => {
				handleRunUpdate(update, statusKey, label, ctx, requestRedraw);
			},
		});
		if (result.status === "failed" && request.mode === "parallel") {
			result = await recoverParallelFailure(result, request, agents, statusKey, label, ctx, requestRedraw);
		}
		liveRuns.set(request.id, result);
		requestRedraw();
		scheduleStateCleanup();
		if (result.status === "failed" && request.mode !== "parallel") {
			const failure = firstFailedSlot(result);
			throw new Error(failure ? `${failure.agent} failed: ${failure.error ?? "failed"}` : `${label} failed.`);
		}
		if (result.status === "cancelled") throw new Error(`Subagent ${label} cancelled.`);
		if (result.status === "partial") {
			const failed = failedSlotNames(result);
			ctx.ui.notify(`${label}: partial — ${failed.length} agent(s) failed: ${failed.join(", ")}.`, "warning");
		}
		return toSubagentResponse(result);
	} finally {
		stopLiveMessageAnimation(request.id);
		clearSubagentStatus(statusKey);
	}
}

function handleRunUpdate(
	update: SubagentRunUpdate,
	statusKey: string,
	label: string,
	ctx: ExtensionCommandContext,
	requestRedraw: () => void,
): void {
	if (update.type === "run-start") {
		liveRuns.set(update.state.id, update.state);
		publishSubagentStatus(statusKey, `${label}: running`, true);
		syncLiveMessageAnimation(update.state.id, requestRedraw);
	} else if (update.type === "slot-update") {
		const run = liveRuns.get(update.runId);
		const runningSlot = "slots" in (run ?? {}) ? run?.slots.find((slot) => slot.status === "running") : undefined;
		publishSubagentStatus(statusKey, runningSlot?.currentTool ? `${label}: ${runningSlot.currentTool}` : `${label}: running`, true);
		syncLiveMessageAnimation(update.runId, requestRedraw);
	} else if (update.type === "event") {
		const run = liveRuns.get(update.runId);
		if (run && "events" in run && !run.events.includes(update.event)) run.events.push(update.event);
		const live = mapEngineEventToLiveLog(update.event).at(-1);
		if (live?.kind === "tool_start") publishSubagentStatus(statusKey, `${label}: ${live.toolName}`, true);
		else if (live?.kind === "turn_start") publishSubagentStatus(statusKey, `${label}: turn ${live.turn}`, true);
		syncLiveMessageAnimation(update.runId, requestRedraw);
	} else if (update.type === "run-end") {
		liveRuns.set(update.result.id, update.result);
		publishSubagentStatus(statusKey, `${label}: ${update.result.status}`);
		stopLiveMessageAnimation(update.result.id);
	}
	requestRedraw();
}

async function recoverParallelFailure(
	result: SubagentRunResult,
	request: SubagentRunRequest,
	agents: readonly ReturnType<typeof discoverAgents>[number][],
	statusKey: string,
	label: string,
	ctx: ExtensionCommandContext,
	requestRedraw: () => void,
): Promise<SubagentRunResult> {
	const failedIds = result.slots.filter((slot) => slot.status === "failed").map((slot) => slot.id);
	if (failedIds.length === 0) return result;
	const failedNames = result.slots.filter((slot) => failedIds.includes(slot.id)).map((slot) => slot.agent).join(", ");
	const shouldRerun = ctx.hasUI
		? await ctx.ui.confirm(`${label}: rerun failed subagent(s)?`, `Failed: ${failedNames}\n\nYes reruns only failed agents. No continues with partial successful output and failure notes.`)
		: false;
	if (!shouldRerun) {
		result.rerun.decision = "continue-partial";
		result.rerun.continuedWithPartialOutput = true;
		result.rerun.note = "User declined failed-agent rerun; continuing with partial output.";
		result.status = "partial";
		result.error = `Continuing with partial output. Failed agents: ${failedNames}`;
		const finalText = buildCappedParentFacingText(result.slots);
		result.finalText = finalText.text;
		result.truncation = finalText.truncation;
		return result;
	}
	const rerunRequest: SubagentRunRequest = {
		...request,
		id: randomUUID(),
		slots: request.slots.filter((slot) => failedIds.includes(slot.id)),
		createdAt: Date.now(),
	};
	result.rerun.decision = "rerun-failed";
	result.rerun.requestedAt = Date.now();
	result.rerun.rerunSlotIds = [...failedIds];
	publishSubagentStatus(statusKey, `${label}: rerunning failed agents`, true);
	const rerun = await runSubagents(rerunRequest, {
		agents,
		onUpdate: (update) => handleRunUpdate(update, statusKey, `${label} rerun`, ctx, requestRedraw),
	});
	return mergeRerunResult(result, rerun, failedIds);
}

function mergeRerunResult(original: SubagentRunResult, rerun: SubagentRunResult, failedIds: string[]): SubagentRunResult {
	const replacements = new Map(rerun.slots.map((slot) => [slot.id, slot]));
	original.slots = original.slots.map((slot) => failedIds.includes(slot.id) ? (replacements.get(slot.id) ?? slot) : slot);
	original.events = [...original.events, ...rerun.events];
	original.usage = combineSubagentUsage(original.slots.map((slot) => slot.usage));
	const stillFailed = original.slots.filter((slot) => slot.status === "failed");
	original.rerun.failedSlotIds = stillFailed.map((slot) => slot.id);
	original.rerun.continuedWithPartialOutput = stillFailed.length > 0;
	if (stillFailed.length > 0) {
		original.status = "partial";
		original.error = `Rerun did not recover all agents. Failed: ${stillFailed.map((slot) => slot.agent).join(", ")}`;
	} else {
		original.status = "completed";
		original.error = undefined;
	}
	const finalText = buildCappedParentFacingText(original.slots);
	original.finalText = finalText.text;
	original.truncation = finalText.truncation;
	return original;
}

function toSubagentResponse(result: SubagentRunResult): SubagentResponse {
	const failedAgents = result.slots.filter((slot) => slot.status === "failed").map((slot) => slot.agent);
	const partialNote = result.status === "partial" && failedAgents.length > 0
		? `\n\n[Partial run: failed agents — ${failedAgents.join(", ")}]`
		: "";
	return {
		requestId: result.id,
		result: {
			content: [{ type: "text", text: `${result.finalText}${partialNote}` }],
			details: {
				run: result,
				results: result.slots.map((slot) => ({
					agent: slot.agent,
					finalOutput: slot.output.finalOutput ?? slot.output.recentOutput,
					error: slot.error,
					exitCode: slot.status === "completed" ? 0 : 1,
				})),
			},
		},
		isError: result.status === "failed" || result.status === "cancelled",
		errorText: result.error,
	};
}

function failedSlotNames(result: SubagentRunResult): string[] {
	return result.slots.filter((slot) => slot.status === "failed").map((slot) => slot.agent);
}

export function extractSubagentText(response: SubagentResponse): string {
	const run = response.result?.details?.run;
	if (run?.finalText) return run.finalText.trim();
	const resultTexts = response.result?.details?.results
		?.map((result) => {
			const body = result.finalOutput || result.error || "";
			return body.trim() ? `## ${result.agent ?? "subagent"}\n\n${body.trim()}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
	const contentText = response.result?.content?.map((part) => part.text).join("\n");
	return (resultTexts || contentText || response.errorText || "").trim();
}

function firstFailedSlot(result: SubagentRunResult) {
	return result.slots.find((slot) => slot.status === "failed");
}
