import type { SubagentExecutionEvent, SubagentRunResult, SubagentRunState, SubagentSlotResult } from "./types.ts";

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

export type SubagentRenderable = SubagentRunState | SubagentRunResult;

export const SUBAGENT_RUN_MESSAGE_TYPE = "subagents-run";

export function renderSubagentRun(run: SubagentRenderable, options: RenderOptions, theme: RendererTheme): RenderComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			return options.expanded ? renderExpanded(run, width, theme) : renderCollapsed(run, width, theme);
		},
	};
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
	const lines: string[] = [];
	const slots = run.slots;
	const completed = slots.filter((slot) => slot.status === "completed").length;
	const failed = slots.filter((slot) => slot.status === "failed").length;
	const cancelled = slots.filter((slot) => slot.status === "cancelled").length;
	const active = slots.filter((slot) => slot.status === "running").length;
	const statusParts = [
		run.mode,
		run.status,
		`${completed}/${slots.length} done`,
		failed ? `${failed} failed` : "",
		cancelled ? `${cancelled} cancelled` : "",
		active ? `${active} running` : "",
	].filter(Boolean);
	lines.push(cut(`${statusIcon(run.status, theme)} ${theme.bold(run.label)} · ${theme.fg("muted", statusParts.join(" · "))}`, width));
	for (const slot of slots) {
		lines.push(cut(`  ${slotIcon(slot.status, theme)} ${slot.agent}${slotMeta(slot, theme)}`, width));
	}
	if (run.status === "running") lines.push(cut(theme.fg("dim", "Press Ctrl+O for live detail"), width));
	return lines;
}

function renderExpanded(run: SubagentRenderable, width: number, theme: RendererTheme): string[] {
	const lines = renderCollapsed(run, width, theme);
	lines.push("");
	for (const slot of run.slots) {
		lines.push(cut(`${slotIcon(slot.status, theme)} ${theme.bold(slot.agent)} · ${slot.status}${slotMeta(slot, theme)}`, width));
		lines.push(cut(theme.fg("muted", `task: ${slot.task}`), width));
		if (slot.error) lines.push(cut(theme.fg("error", `error: ${slot.error}`), width));
		if (slot.tools.length > 0) {
			lines.push(cut("tools:", width));
			for (const tool of slot.tools.slice(-8)) {
				const preview = tool.preview ? ` — ${singleLine(tool.preview)}` : "";
				lines.push(cut(`  ${toolStatusIcon(tool.status, theme)} ${tool.name}${tool.argsSummary ? ` ${theme.fg("dim", tool.argsSummary)}` : ""}${preview}`, width));
				if (tool.previewTruncation?.truncated) lines.push(cut(theme.fg("warning", `    ${tool.previewTruncation.note ?? "tool preview truncated"}`), width));
			}
		}
		const output = slot.output.finalOutput ?? slot.output.recentOutput;
		if (output) {
			lines.push(cut(slot.output.finalOutput ? "final output:" : "recent output:", width));
			for (const line of wrapIndented(output, width, "  ").slice(-12)) lines.push(line);
			if (slot.output.truncation?.truncated) lines.push(cut(theme.fg("warning", `  ${slot.output.truncation.note ?? "output truncated"}`), width));
		}
		const events = eventsForSlot(run.events, slot.id).slice(-10);
		if (events.length > 0) {
			lines.push(cut("recent events:", width));
			for (const event of events) lines.push(cut(`  ${eventLine(event)}`, width));
		}
		lines.push("");
	}
	if ("truncation" in run && run.truncation?.truncated) {
		lines.push(cut(theme.fg("warning", run.truncation.note ?? "parent result truncated"), width));
	}
	return lines;
}

function slotMeta(slot: SubagentSlotResult, theme: RendererTheme): string {
	const parts = [
		slot.currentTool ? `tool ${slot.currentTool}` : "",
		slot.toolCount ? `${slot.toolCount} tools` : "",
		slot.duration.elapsedMs ? formatDuration(slot.duration.elapsedMs) : "",
		formatUsage(slot.usage),
	].filter(Boolean);
	return parts.length > 0 ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
}

function statusIcon(status: string, theme: RendererTheme): string {
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "partial") return theme.fg("warning", "◑");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "cancelled") return theme.fg("warning", "◼");
	return theme.fg("warning", "⏵");
}

function slotIcon(status: string, theme: RendererTheme): string {
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "cancelled") return theme.fg("warning", "◼");
	if (status === "running") return theme.fg("warning", "⏵");
	return theme.fg("muted", "·");
}

function toolStatusIcon(status: string, theme: RendererTheme): string {
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "cancelled") return theme.fg("warning", "◼");
	return theme.fg("warning", "⏵");
}

function formatUsage(usage: { inputTokens: number; outputTokens: number; costUsd?: number }): string {
	const tokens = usage.inputTokens + usage.outputTokens;
	const cost = usage.costUsd ? `$${usage.costUsd.toFixed(4)}` : "";
	return [tokens ? `${tokens} tok` : "", cost].filter(Boolean).join(" · ");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function eventsForSlot(events: readonly SubagentExecutionEvent[], slotId: string): SubagentExecutionEvent[] {
	return events.filter((event) => event.slotId === slotId);
}

function eventLine(event: SubagentExecutionEvent): string {
	if (event.type === "tool-start") return `tool start: ${event.tool?.name ?? "tool"}`;
	if (event.type === "tool-end") return `tool end: ${event.tool?.name ?? "tool"}`;
	if (event.type === "slot-output") return `output: ${singleLine(event.text ?? "")}`;
	if (event.error) return `${event.type}: ${event.error}`;
	return event.type;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function wrapIndented(text: string, width: number, indent: string): string[] {
	const innerWidth = Math.max(8, width - indent.length);
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		let rest = raw;
		do {
			lines.push(cut(`${indent}${rest.slice(0, innerWidth)}`, width));
			rest = rest.slice(innerWidth);
		} while (rest.length > 0);
	}
	return lines;
}

function cut(text: string, width: number): string {
	if (width <= 0 || text.length <= width) return text;
	return `${text.slice(0, Math.max(0, width - 1))}…`;
}
