import { homedir } from "node:os";
import type { LiveLogEntry, SubagentExecutionEvent, SubagentRunResult, SubagentRunState, SubagentSlotResult, SubagentToolSnapshot, SubagentUsage } from "./types.ts";
import { combineSubagentUsage, mapSlotEventsToLiveLog } from "./types.ts";

// Adapt richer render-tree shapes (anything with `.render(width)`) to Pi's
// string[] RenderComponent contract at this boundary, so the runner stays
// decoupled from the underlying tree implementation.

export interface RendererTheme {
	fg(name: string, text: string): string;
	bold(text: string): string;
}

export interface RenderOptions {
	expanded: boolean;
	isPartial?: boolean;
}

export interface RenderComponent {
	render(width: number): string[];
	invalidate(): void;
}

export interface RenderTreeLike {
	render(width: number): string[];
	invalidate?(): void;
}

export type SubagentRenderable = SubagentRunState | SubagentRunResult;

export const SUBAGENT_RUN_MESSAGE_TYPE = "subagents-run";

export function asRenderComponent(tree: RenderTreeLike): RenderComponent {
	return {
		invalidate() {
			tree.invalidate?.();
		},
		render(width: number): string[] {
			return tree.render(width);
		},
	};
}

export function renderSubagentRun(run: SubagentRenderable, options: RenderOptions, theme: RendererTheme): RenderComponent {
	return asRenderComponent({
		invalidate() {},
		render(width: number): string[] {
			return options.expanded ? renderExpanded(run, width, theme) : renderCollapsed(run, width, theme);
		},
	});
}

export function createSubagentMessageRenderer(liveRuns?: ReadonlyMap<string, SubagentRenderable>) {
	return (message: { details?: unknown; content?: unknown }, options: RenderOptions, theme: RendererTheme): RenderComponent => {
		const run = extractRenderableRun(message.details, liveRuns);
		if (run) return renderSubagentRun(run, options, theme);
		return makePlaceholder(theme, "Subagent run details unavailable.");
	};
}

export function renderSubagentToolResult(
	result: { details?: unknown },
	options: RenderOptions,
	theme: RendererTheme,
): RenderComponent {
	const run = extractRenderableRun(result.details);
	if (run) return renderSubagentRun(run, options, theme);
	return makePlaceholder(theme, "Subagent result has no run details.");
}

function extractRenderableRun(
	details: unknown,
	liveRuns?: ReadonlyMap<string, SubagentRenderable>,
): SubagentRenderable | undefined {
	if (!details || typeof details !== "object") return undefined;
	const data = details as { runId?: unknown; run?: unknown; result?: unknown; state?: unknown };
	if (isRenderableRun(data.run)) return data.run;
	if (isRenderableRun(data.result)) return data.result;
	if (isRenderableRun(data.state)) return data.state;
	if (typeof data.runId === "string" && liveRuns) {
		const live = liveRuns.get(data.runId);
		if (isRenderableRun(live)) return live;
	}
	return undefined;
}

function isRenderableRun(value: unknown): value is SubagentRenderable {
	return Boolean(value)
		&& typeof value === "object"
		&& Array.isArray((value as { slots?: unknown }).slots);
}

function makePlaceholder(theme: RendererTheme, message: string): RenderComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			return [cut(theme.fg("muted", message), width)];
		},
	};
}

function renderCollapsed(run: SubagentRenderable, width: number, theme: RendererTheme): string[] {
	const depth = run.request?.depth ?? 0;
	const lines: string[] = [];
	lines.push(row(width, depth, `${runIcon(run.status, theme)} ${theme.bold(run.label)} · ${topLevelSummary(run, theme)}`));
	for (const slot of run.slots) {
		lines.push(row(width, depth + 1, `${slotIcon(slot.status, theme)} ${slot.agent}${slotSummary(slot, theme)}`));
		if (slot.status === "running") {
			for (const liveLine of renderLiveLog(run.events, slot, theme, depth + 2, width).slice(-3)) lines.push(liveLine);
		}
	}
	return lines;
}

function renderExpanded(run: SubagentRenderable, width: number, theme: RendererTheme): string[] {
	const depth = run.request?.depth ?? 0;
	const lines: string[] = [];
	lines.push(row(width, depth, `${runIcon(run.status, theme)} ${theme.bold(run.label)} · ${topLevelSummary(run, theme)}`));
	lines.push(row(width, depth, theme.fg("muted", `mode ${run.mode} · ${formatDuration(run.duration?.elapsedMs ?? Date.now() - run.startedAt)}`)));
	lines.push("");

	for (const slot of run.slots) {
		lines.push(row(width, depth + 1, `${slotIcon(slot.status, theme)} ${theme.bold(slot.agent)} · ${slot.status}${slotSummary(slot, theme)}`));
		lines.push(row(width, depth + 2, theme.fg("muted", `task: ${slot.task}`)));
		if (slot.error) lines.push(row(width, depth + 2, theme.fg("error", `error: ${slot.error}`)));

		const liveLines = renderLiveLog(run.events, slot, theme, depth + 2, width);
		if (liveLines.length > 0) lines.push(...liveLines.slice(-8));

		if (slot.tools.length > 0) {
			lines.push(row(width, depth + 2, "tools"));
			for (const tool of slot.tools.slice(-8)) lines.push(...renderTool(tool, theme, depth + 3, width));
		}

		const outputLines = outputPreview(slot);
		if (outputLines.length > 0) {
			lines.push(row(width, depth + 2, slot.output.finalOutput ? "final output" : "recent output"));
			for (const line of outputLines) lines.push(row(width, depth + 3, theme.fg("dim", line)));
			if (slot.output.truncation?.truncated) lines.push(row(width, depth + 3, theme.fg("warning", slot.output.truncation.note ?? "output truncated")));
		}

		lines.push("");
	}

	if ("truncation" in run && run.truncation?.truncated) lines.push(row(width, depth, theme.fg("warning", run.truncation.note ?? "parent result truncated")));
	return lines;
}

function topLevelSummary(run: SubagentRenderable, theme: RendererTheme): string {
	const running = run.slots.filter((slot) => slot.status === "running" || slot.status === "pending").length;
	const finished = run.slots.filter((slot) => slot.status === "completed" || slot.status === "failed" || slot.status === "cancelled" || slot.status === "skipped").length;
	const ok = run.slots.filter((slot) => slot.status === "completed" || slot.status === "skipped").length;
	const error = run.slots.filter((slot) => slot.status === "failed" || slot.status === "cancelled").length;
	const usage = formatUsage(combineSubagentUsage(run.slots.map((slot) => slot.usage)));
	return theme.fg("muted", [`running ${running}`, `finished ${finished}/${run.slots.length}`, `ok ${ok}`, `error ${error}`, usage].filter(Boolean).join(" · "));
}

function slotSummary(slot: SubagentSlotResult, theme: RendererTheme): string {
	const parts = [
		slot.currentTool ? `tool ${slot.currentTool}` : "",
		slot.toolCount ? `${slot.toolCount} tools` : "",
		formatDuration(slot.duration.elapsedMs),
		formatUsage(slot.usage, { model: slot.model }),
	].filter(Boolean);
	return parts.length > 0 ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
}

function renderTool(tool: SubagentToolSnapshot, theme: RendererTheme, depth: number, width: number): string[] {
	const preview = tool.preview ? ` → ${truncate(singleLine(tool.preview), 52)}` : "";
	const args = toolArgPreview(tool);
	const elapsed = tool.elapsedMs ? ` · ${formatDuration(tool.elapsedMs)}` : "";
	const line = `${toolIcon(tool.status, theme)} ${tool.name}${args ? ` ${theme.fg("dim", args)}` : ""}${elapsed}${preview}`;
	const lines = [row(width, depth, line)];
	if (tool.error) lines.push(row(width, depth + 1, theme.fg("error", truncate(singleLine(tool.error), 80))));
	if (tool.previewTruncation?.truncated) lines.push(row(width, depth + 1, theme.fg("warning", tool.previewTruncation.note ?? "tool preview truncated")));
	return lines;
}

function renderLiveLog(events: readonly SubagentExecutionEvent[], slot: SubagentSlotResult, theme: RendererTheme, depth: number, width: number): string[] {
	const entries = mapSlotEventsToLiveLog(events, slot.id);
	if (entries.length === 0) return [];
	return entries.slice(-6).map((entry) => row(width, depth, theme.fg("dim", liveLogLine(entry))));
}

function liveLogLine(entry: LiveLogEntry): string {
	if (entry.kind === "turn_start") return `↳ turn ${entry.turn} start${entry.synthetic ? " (synthetic)" : ""}`;
	if (entry.kind === "turn_end") return `↳ turn ${entry.turn} end ${formatTokens(entry.inputTokens + entry.outputTokens)} tok${entry.synthetic ? " (synthetic)" : ""}`;
	if (entry.kind === "tool_start") return `↳ ${entry.toolName} ${toolArgPreview({ name: entry.toolName, status: "running", args: entry.args, id: "live" })}`.trimEnd();
	return `↳ ${entry.toolName} done`;
}

function outputPreview(slot: SubagentSlotResult): string[] {
	const output = slot.output.finalOutput ?? slot.output.recentOutput;
	return output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(-6)
		.map((line) => truncate(line, 120));
}

function runIcon(status: string, theme: RendererTheme): string {
	if (status === "completed") return theme.fg("success", "✅");
	if (status === "failed" || status === "cancelled") return theme.fg("error", "❌");
	if (status === "partial") return theme.fg("warning", "❌");
	return theme.fg("warning", "⏳");
}

function slotIcon(status: string, theme: RendererTheme): string {
	if (status === "completed" || status === "skipped") return theme.fg("success", "✅");
	if (status === "failed" || status === "cancelled") return theme.fg("error", "❌");
	if (status === "running") return theme.fg("warning", "⏳");
	return theme.fg("muted", "⏳");
}

function toolIcon(status: string, theme: RendererTheme): string {
	if (status === "completed") return theme.fg("success", "✅");
	if (status === "failed" || status === "cancelled") return theme.fg("error", "❌");
	return theme.fg("warning", "⏳");
}

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens >= 1_000_000) return `${trimUnit(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${trimUnit(tokens / 1_000)}k`;
	return String(Math.round(tokens));
}

export function formatUsage(usage: SubagentUsage, extras: { context?: number | string; model?: string } = {}): string {
	const total = usage.inputTokens + usage.outputTokens;
	return [
		usage.turns ? `${usage.turns} turns` : "",
		total ? `${formatTokens(total)} tok` : "",
		usage.inputTokens ? `${formatTokens(usage.inputTokens)} in` : "",
		usage.outputTokens ? `${formatTokens(usage.outputTokens)} out` : "",
		usage.cacheReadTokens ? `${formatTokens(usage.cacheReadTokens)} cacheR` : "",
		usage.cacheWriteTokens ? `${formatTokens(usage.cacheWriteTokens)} cacheW` : "",
		usage.costUsd ? `cost $${usage.costUsd.toFixed(4)}` : "",
		extras.context !== undefined ? `${extras.context} ctx` : "",
		extras.model ? `${extras.model}` : "",
	].filter(Boolean).join(" · ");
}

export function toolArgPreview(tool: Pick<SubagentToolSnapshot, "name" | "args" | "argsSummary">): string {
	const args = tool.args ?? parseArgsSummary(tool.argsSummary);
	const name = tool.name;
	if (name === "bash") return truncate(singleLine(stringArg(args, "command") ?? tool.argsSummary ?? ""), 52);
	if (name === "read" || name === "write" || name === "edit") return truncate(shortPath(stringArg(args, "path") ?? tool.argsSummary ?? ""), 52);
	if (name === "grep") {
		const pattern = stringArg(args, "pattern") ?? stringArg(args, "query") ?? "";
		const path = stringArg(args, "path");
		return truncate(`${pattern ? `/${pattern}/` : "grep"}${path ? ` in ${shortPath(path)}` : ""}`, 52);
	}
	if (name === "find") {
		const pattern = stringArg(args, "pattern") ?? "find";
		const path = stringArg(args, "path");
		return truncate(`${pattern}${path ? ` in ${shortPath(path)}` : ""}`, 52);
	}
	if (name === "subagent") return truncate(subagentNames(args) || tool.argsSummary || "", 52);
	return truncate(singleLine(tool.argsSummary ?? summarizeRecord(args)), 52);
}

function subagentNames(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	if (typeof args.agent === "string") return args.agent;
	if (Array.isArray(args.tasks)) {
		return args.tasks
			.map((task) => task && typeof task === "object" ? (task as { agent?: unknown }).agent : undefined)
			.filter((agent): agent is string => typeof agent === "string")
			.join(", ");
	}
	return "";
}

function parseArgsSummary(summary: string | undefined): Record<string, unknown> | undefined {
	if (!summary) return undefined;
	try {
		const parsed = JSON.parse(summary);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" ? value : undefined;
}

function summarizeRecord(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

function shortPath(path: string): string {
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function formatDuration(ms: number | undefined): string {
	if (!ms) return "";
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function trimUnit(value: number): string {
	return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function row(width: number, depth: number, text: string): string {
	return cut(`${"  ".repeat(Math.max(0, depth))}${text}`, width);
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function cut(text: string, width: number): string {
	if (width <= 0 || text.length <= width) return text;
	return `${text.slice(0, Math.max(0, width - 1))}…`;
}
