// ABOUT: Visual primitives lifted from nicobailon/pi-subagents: glyphs, spinner,
// truncation, stat formatting. No knowledge of our domain types; pure formatters
// the renderer in render.ts composes with.

import { homedir } from "node:os";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SUBAGENT_ANIMATION_MS = 80;

const ANSI_RESET = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/y;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / SUBAGENT_ANIMATION_MS) % SPINNER.length]!;
}

/**
 * ANSI-aware width-truncation. pi-tui's truncateToWidth drops styles before the
 * ellipsis and bleeds bg colors; this preserves active styles through the cut.
 */
export function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const targetWidth = Math.max(0, maxWidth - 1);
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;
	while (i < text.length) {
		const ansiCode = ansiAt(text, i);
		if (ansiCode) {
			result += ansiCode;
			if (ansiCode === ANSI_RESET || ansiCode === "\x1b[m") activeStyles = [];
			else activeStyles.push(ansiCode);
			i += ansiCode.length;
			continue;
		}

		const nextAnsi = text.indexOf("\x1b[", i);
		const end = nextAnsi === -1 ? text.length : Math.max(i + 1, nextAnsi);
		for (const seg of segmenter.segment(text.slice(i, end))) {
			const w = visibleWidth(seg.segment);
			if (currentWidth + w > targetWidth) return finishTruncated(result, activeStyles);
			result += seg.segment;
			currentWidth += w;
		}
		i = end;
	}
	return finishTruncated(result, activeStyles);
}

function ansiAt(text: string, index: number): string | undefined {
	ANSI_PATTERN.lastIndex = index;
	return ANSI_PATTERN.exec(text)?.[0];
}

function finishTruncated(result: string, activeStyles: readonly string[]): string {
	return activeStyles.length > 0
		? `${result}${activeStyles.join("")}…${ANSI_RESET}`
		: `${result}…`;
}

export function themeBold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

/** Join non-empty parts with a dimmed `·` separator. */
export function statJoin(theme: Theme, parts: readonly (string | undefined | false)[]): string {
	const filtered = parts.filter((part): part is string => Boolean(part));
	return filtered.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens >= 1_000_000) return `${trimUnit(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${trimUnit(tokens / 1_000)}k`;
	return String(Math.round(tokens));
}

function trimUnit(value: number): string {
	return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

export function formatDuration(ms: number | undefined): string {
	if (!ms || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function shortenPath(filePath: string): string {
	const home = homedir();
	if (home && filePath.startsWith(`${home}/`)) return `~/${filePath.slice(home.length + 1)}`;
	return filePath;
}

export function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

export function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} ${tokens === 1 ? "token" : "tokens"}`;
}

/** Compact arg preview for common tools; falls back to JSON-trimmed dump. */
export function formatToolCall(name: string, args: Record<string, unknown> | undefined, expanded = false): string {
	const max = expanded ? 240 : 60;
	if (name === "bash") {
		const cmd = stringArg(args, "command") ?? "";
		return `$ ${truncate(singleLine(cmd), max)}`;
	}
	if (name === "read" || name === "write" || name === "edit") {
		const target = stringArg(args, "path") ?? stringArg(args, "file_path") ?? "";
		return truncate(`${name} ${shortenPath(target)}`, max);
	}
	if (name === "grep") {
		const pat = stringArg(args, "pattern") ?? stringArg(args, "query") ?? "";
		const path = stringArg(args, "path");
		return truncate(`${pat ? `/${pat}/` : "grep"}${path ? ` in ${shortenPath(path)}` : ""}`, max);
	}
	if (name === "find") {
		const pat = stringArg(args, "pattern") ?? "find";
		const path = stringArg(args, "path");
		return truncate(`${pat}${path ? ` in ${shortenPath(path)}` : ""}`, max);
	}
	const dump = args ? JSON.stringify(args) : "";
	return `${name} ${truncate(singleLine(dump), max)}`.trimEnd();
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" ? value : undefined;
}

export function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// SECTION: GLYPHS //
// Colored sigils for status badges. Spinner rotates by clock so any redraw
// advances the frame without per-component animation state.

export function runGlyph(status: string, theme: Theme): string {
	if (status === "running") return theme.fg("accent", spinnerFrame());
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "partial") return theme.fg("warning", "⚠");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "cancelled") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function slotGlyph(status: string, theme: Theme): string {
	if (status === "running") return theme.fg("accent", spinnerFrame());
	if (status === "completed" || status === "skipped") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "cancelled") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function toolGlyph(status: string, theme: Theme): string {
	if (status === "running") return theme.fg("accent", spinnerFrame());
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "failed" || status === "cancelled") return theme.fg("error", "✗");
	return theme.fg("muted", "◦");
}
