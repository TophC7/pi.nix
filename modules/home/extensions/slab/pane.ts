// ABOUT: Slab's multi-category settings pane. The single-category settings
// primitive in @pi/lib/ui (showSettingsPane / SettingsList) doesn't fit this
// pane's category-grid + per-row mutate model. §T023 retained the current
// Component structure; promoting a multi-category settings primitive into
// @pi/lib/ui is tracked as future work after this spec lands.

import { matchesKey } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	fitLine as fitLineShared,
	padLine,
	renderDialogDivider,
	renderDialogFooter,
	renderDialogHeader,
	renderFooterBridgeLines,
	type DialogContent,
} from "@pi/lib/ui";
import { cloneSlabConfig, defaultSlabConfig, moveSlabSegment, toggleSlabSegment } from "./config.ts";
import { wrapSlabEditorLines, type SlabEditorState } from "./editor.ts";
import { parseGitStatus } from "./git.ts";
import type { SlabConfig, SlabSegmentId } from "./types.ts";

export type SlabPaneResult = { action: "save"; config: SlabConfig } | { action: "cancel" };

type CategoryId = "general" | "display" | "editor" | "segments" | "model" | "git" | "context" | "cost" | "tokens";

type SettingRow = {
	label: string;
	value: string;
	hint: string;
	mutate?: () => void;
	segmentId?: SlabSegmentId;
};

const CATEGORIES: { id: CategoryId; label: string }[] = [
	{ id: "general", label: "General" },
	{ id: "display", label: "Display" },
	{ id: "editor", label: "Editor" },
	{ id: "segments", label: "Segments" },
	{ id: "model", label: "Model" },
	{ id: "git", label: "Git" },
	{ id: "context", label: "Context" },
	{ id: "cost", label: "Cost" },
	{ id: "tokens", label: "Tokens" },
];

function nextIn<T extends string>(current: T, values: readonly T[]): T {
	const index = values.indexOf(current);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function nextNumber<T extends number>(current: number, values: readonly T[]): T {
	const index = values.indexOf(current as T);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

function segmentLabel(id: SlabSegmentId): string {
	return id[0]!.toUpperCase() + id.slice(1);
}

function row(label: string, value: string, hint: string, mutate?: () => void, segmentId?: SlabSegmentId): SettingRow {
	return { label, value, hint, mutate, segmentId };
}

export function slabPaneRows(config: SlabConfig, category: CategoryId, replace: (config: SlabConfig) => void): SettingRow[] {
	switch (category) {
		case "general":
			return [
				row("Enabled", onOff(config.enabled), "Disable restores stock Pi input.", () => { const next = cloneSlabConfig(config); next.enabled = !next.enabled; replace(next); }),
				row("Theme", config.theme, "Cycle color palette.", () => { const next = cloneSlabConfig(config); next.theme = nextIn(next.theme, ["light", "dark", "catppuccin-latte", "catppuccin-mocha"] as const); replace(next); }),
				row("Icons", config.icons, "Plain works without Nerd Font.", () => { const next = cloneSlabConfig(config); next.icons = nextIn(next.icons, ["plain", "nerd"] as const); replace(next); }),
			];
		case "display":
			return [
				row("Adaptive", onOff(config.display.adaptive), "Drop later segments first at narrow widths.", () => { const next = cloneSlabConfig(config); next.display.adaptive = !next.display.adaptive; replace(next); }),
				row("Provider", config.display.showProvider, "Show model provider name.", () => { const next = cloneSlabConfig(config); next.display.showProvider = nextIn(next.display.showProvider, ["auto", "always", "never"] as const); replace(next); }),
				row("Workspace", config.display.workspaceLabel, "Workspace title mode.", () => { const next = cloneSlabConfig(config); next.display.workspaceLabel = nextIn(next.display.workspaceLabel, ["name", "smart", "path"] as const); replace(next); }),
			];
		case "editor":
			return [
				row("Min rows", `${config.editor.minContentRows}`, "Resting editor height.", () => { const next = cloneSlabConfig(config); next.editor.minContentRows = nextNumber(next.editor.minContentRows, [2, 3, 4] as const); replace(next); }),
			];
		case "segments":
			return [
				...config.segments.map((segment) => row(segmentLabel(segment.id), onOff(segment.enabled), "Enter toggles. U/D reorders selected segment.", () => replace(toggleSlabSegment(config, segment.id)), segment.id)),
				row("Order", config.segments.map((segment) => segment.id).join(" → "), "Segment order/enabled state is saved."),
			];
		case "model":
			return [
				row("Thinking", config.model.showThinking, "Show thinking level.", () => { const next = cloneSlabConfig(config); next.model.showThinking = nextIn(next.model.showThinking, ["auto", "always", "never"] as const); replace(next); }),
				row("Custom names", `${Object.keys(config.model.customNames).length}`, "Custom model aliases persist in config JSON."),
			];
		case "git":
			return [
				row("Dirty mark", onOff(config.git.showDirty), "Show dirty/conflict mark.", () => { const next = cloneSlabConfig(config); next.git.showDirty = !next.git.showDirty; replace(next); }),
				row("Ahead/behind", onOff(config.git.showAheadBehind), "Show upstream divergence.", () => { const next = cloneSlabConfig(config); next.git.showAheadBehind = !next.git.showAheadBehind; replace(next); }),
				row("SHA", config.git.shaMode, "Detached/always/off short SHA.", () => { const next = cloneSlabConfig(config); next.git.shaMode = nextIn(next.git.shaMode, ["off", "detached", "always"] as const); replace(next); }),
				row("Timeout", `${config.git.timeoutMs}ms`, "Git command timeout."),
				row("Debounce", `${config.git.refreshDebounceMs}ms`, "Event refresh debounce."),
			];
		case "context":
			return [
				row("Display", config.context.display, "Percent, tokens, or both.", () => { const next = cloneSlabConfig(config); next.context.display = nextIn(next.context.display, ["percent+tokens", "percent", "tokens"] as const); replace(next); }),
				row("Unknown", config.context.unknown, "Show/hide unknown context.", () => { const next = cloneSlabConfig(config); next.context.unknown = nextIn(next.context.unknown, ["show", "hide"] as const); replace(next); }),
			];
		case "cost":
			return [
				row("Hide zero", onOff(config.cost.hideZero), "Hide cost until non-zero.", () => { const next = cloneSlabConfig(config); next.cost.hideZero = !next.cost.hideZero; replace(next); }),
			];
		case "tokens":
			return [
				row("Display", config.tokens.display, "Input/output or total.", () => { const next = cloneSlabConfig(config); next.tokens.display = nextIn(next.tokens.display, ["input-output", "total"] as const); replace(next); }),
				row("Cache", config.tokens.cache, "Auto/show/hide cache tokens.", () => { const next = cloneSlabConfig(config); next.tokens.cache = nextIn(next.tokens.cache, ["auto", "show", "hide"] as const); replace(next); }),
			];
	}
}

function sampleState(config: SlabConfig): SlabEditorState {
	return {
		config,
		clock: { now: 1_000, tick: 3 },
		snapshot: { statuses: [], widgets: [], version: 1 },
		surface: {
			workspace: { name: "pi.nix", path: "/repo/Nix/pi.nix" },
			git: parseGitStatus(`# branch.oid abcdef1234567890
# branch.head main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 a b file.ts
`, 1_000),
			providers: { availableCount: 2 },
			model: { id: "claude-sonnet-4-20250514", provider: "anthropic", displayName: "Sonnet 4", thinking: "high" },
			context: { tokens: 46_800, window: 200_000, percent: 23.4 },
			usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 0, cost: 0.042 },
			statuses: [{ id: "preview-status", owner: "slab", label: "agent", text: "ready", ordering: { priority: "normal", order: 0 }, lifecycle: { createdAt: 1_000, updatedAt: 1_000 } }],
			version: 1,
		},
	};
}

export function renderSlabConfigPreview(config: SlabConfig, width: number): string[] {
	if (!config.enabled) return ["stock Pi input (slab disabled)", ...renderFooterBridgeLines(["typed footer widget"], ["legacy status"], width, { color: false, unicode: true })];
	return [
		...wrapSlabEditorLines(["╭────╮", "Ask Pi to refactor this module", "╰────╯", "autocomplete preview"], {
			state: sampleState(config),
			width,
			capabilities: { color: false, unicode: true },
			focused: true,
		}),
		...renderFooterBridgeLines(["typed footer widget"], ["legacy status"], width, { color: false, unicode: true }),
	];
}

function sameConfig(left: SlabConfig, right: SlabConfig): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function paint(theme: Theme, tone: "accent" | "muted" | "dim" | "success" | "warning", text: string): string {
	return theme.fg(tone, text);
}

function padTo(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	return padLine(fitLineShared(text, safeWidth), safeWidth);
}

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	return padLine(fitLineShared(text, safeWidth), safeWidth);
}

const FOOTER_KEYS = [
	{ key: "←/→", label: "category" },
	{ key: "↑/↓", label: "row" },
	{ key: "Enter", label: "cycle" },
	{ key: "U/D", label: "reorder" },
	{ key: "S", label: "save" },
	{ key: "R", label: "reset" },
	{ key: "Esc", label: "cancel" },
] as const;

export class SlabConfigPane implements DialogContent {
	private readonly initial: SlabConfig;
	private draft: SlabConfig;
	private categoryIndex = 0;
	private rowIndex = 0;
	private status = "";

	constructor(initial: SlabConfig, private readonly theme: Theme, private readonly done: (result: SlabPaneResult) => void) {
		this.initial = cloneSlabConfig(initial);
		this.draft = cloneSlabConfig(initial);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done({ action: "cancel" });
			return;
		}
		if (data === "s" || data === "S") {
			this.done({ action: "save", config: cloneSlabConfig(this.draft) });
			return;
		}
		if (data === "r" || data === "R") {
			this.draft = defaultSlabConfig();
			this.status = "reset to defaults";
			return;
		}
		if (matchesKey(data, "left")) this.moveCategory(-1);
		else if (matchesKey(data, "right")) this.moveCategory(1);
		else if (matchesKey(data, "up")) this.moveRow(-1);
		else if (matchesKey(data, "down")) this.moveRow(1);
		else if (data === "u" || data === "U") this.moveSelectedSegment(-1);
		else if (data === "d" || data === "D") this.moveSelectedSegment(1);
		else if (matchesKey(data, "enter") || data === " ") this.mutateSelected();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(40, width);
		const rows = this.rows();
		const category = CATEGORIES[this.categoryIndex]!;
		const dirty = sameConfig(this.initial, this.draft);
		const statusText = dirty ? "saved" : `dirty${this.status ? ` · ${this.status}` : ""}`;

		const header = renderDialogHeader({
			title: `Slab config  ·  ${statusText}`,
			theme: this.theme,
			width: safeWidth,
		});
		const footer = renderDialogFooter({
			theme: this.theme,
			width: safeWidth,
			keys: FOOTER_KEYS,
		});

		const lines: string[] = [header, renderDialogDivider({ theme: this.theme, width: safeWidth })];
		lines.push(...this.renderCategoryTabs(safeWidth));
		lines.push(renderDialogDivider({ theme: this.theme, width: safeWidth }));
		lines.push(...this.renderSettingRows(rows, category.label, safeWidth));
		lines.push(renderDialogDivider({ theme: this.theme, width: safeWidth }));
		lines.push(...this.renderPreviewSection(safeWidth));
		lines.push(renderDialogDivider({ theme: this.theme, width: safeWidth }));
		lines.push(footer);
		return lines;
	}

	private renderCategoryTabs(width: number): string[] {
		const parts = CATEGORIES.map((item, index) => index === this.categoryIndex
			? this.theme.fg("accent", this.theme.bold(` ${item.label} ▸`))
			: this.theme.fg("dim", `  ${item.label}  `));
		const joined = parts.join(this.theme.fg("dim", "│"));
		return ["", fitLine(`  ${joined}`, width), ""];
	}

	private renderSettingRows(rows: readonly SettingRow[], categoryLabel: string, width: number): string[] {
		const lines: string[] = ["", fitLine(`  ${this.theme.fg("muted", this.theme.bold(categoryLabel.toUpperCase()))}`, width)];
		if (rows.length === 0) {
			lines.push(fitLine(`  ${this.theme.fg("dim", "No settings.")}`, width));
		} else {
			const labelWidth = 22;
			const valueWidth = 22;
			const hintWidth = Math.max(8, width - labelWidth - valueWidth - 8);
			rows.forEach((row, index) => {
				const selected = index === this.rowIndex;
				const cursor = selected ? this.theme.fg("accent", this.theme.bold("›")) : " ";
				const label = padTo(row.label, labelWidth);
				const value = padTo(row.value, valueWidth);
				const hint = padTo(row.hint, hintWidth);
				const styledLabel = selected ? this.theme.bold(label) : label;
				const styledValue = selected ? this.theme.fg("accent", value) : this.theme.fg("muted", value);
				const styledHint = this.theme.fg("dim", hint);
				lines.push(fitLine(` ${cursor} ${styledLabel}  ${styledValue}  ${styledHint}`, width));
			});
		}
		lines.push("");
		return lines;
	}

	private renderPreviewSection(width: number): string[] {
		const previewWidth = Math.max(32, width - 4);
		return [
			"",
			fitLine(`  ${this.theme.fg("muted", this.theme.bold("PREVIEW"))}`, width),
			"",
			...renderSlabConfigPreview(this.draft, previewWidth).map((line) => fitLine(`  ${line}`, width)),
			"",
		];
	}

	private rows(): SettingRow[] {
		return slabPaneRows(this.draft, CATEGORIES[this.categoryIndex]!.id, (next) => {
			this.draft = next;
			this.status = "changed";
		});
	}

	private moveCategory(direction: -1 | 1): void {
		this.categoryIndex = (this.categoryIndex + direction + CATEGORIES.length) % CATEGORIES.length;
		this.rowIndex = 0;
	}

	private moveRow(direction: -1 | 1): void {
		const rows = this.rows();
		if (rows.length === 0) return;
		this.rowIndex = (this.rowIndex + direction + rows.length) % rows.length;
	}

	private mutateSelected(): void {
		const item = this.rows()[this.rowIndex];
		item?.mutate?.();
	}

	private moveSelectedSegment(direction: -1 | 1): void {
		const item = this.rows()[this.rowIndex];
		if (!item?.segmentId) return;
		this.draft = moveSlabSegment(this.draft, item.segmentId, direction);
		this.status = "segment moved";
	}
}
