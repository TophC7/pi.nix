import {
	CustomEditor,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import { stripControls, UiWidgetHost, type UiRenderCapabilities, type UiRenderClock, type UiSnapshot, type UiWidgetEntry } from "@pi/lib/ui";
import { fg, SLAB_PALETTES } from "./palette.ts";
import { renderSlabLine } from "./renderer.ts";
import type { SlabConfig, SlabRuntimeState } from "./types.ts";

const CONTENT_PADDING_X = 1;
const AUTOCOMPLETE_INDENT = 1 + CONTENT_PADDING_X;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const BORDER = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	vertical: "│",
	horizontal: "─",
};

export interface SlabEditorState {
	config: SlabConfig;
	surface: SlabRuntimeState;
	snapshot: UiSnapshot;
	clock: UiRenderClock;
}

export interface SlabEditorWrapOptions {
	state: SlabEditorState;
	width: number;
	capabilities: UiRenderCapabilities;
	focused: boolean;
}

function clean(text: string, caps: UiRenderCapabilities): string {
	return caps.color ? text : text.replace(ANSI_PATTERN, "");
}

function fit(text: string, width: number, caps: UiRenderCapabilities): string {
	return truncateToWidth(clean(text, caps), Math.max(0, width), caps.unicode ? "…" : "...");
}

function ansiPadRight(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function normalizeRenderedLine(line: string, width: number, caps: UiRenderCapabilities): string {
	const text = clean(line, caps);
	const lineWidth = visibleWidth(text);
	if (lineWidth === width) return text;
	if (lineWidth < width) return `${text}${" ".repeat(width - lineWidth)}`;
	return truncateToWidth(text, width, caps.unicode ? "…" : "...");
}

function indentAutocompleteLine(line: string, width: number, caps: UiRenderCapabilities): string {
	const indent = " ".repeat(Math.min(AUTOCOMPLETE_INDENT, Math.max(0, width - 1)));
	return normalizeRenderedLine(`${indent}${line}`, width, caps);
}

function isHorizontalBorder(line: string): boolean {
	const plain = stripControls(line).trim();
	return plain.length > 0
		&& plain.includes(BORDER.horizontal)
		&& [...plain].every((char) => "╭╮╰╯".includes(char) || char === BORDER.horizontal || char === "↑" || char === "↓" || char === " " || /[0-9a-z]/i.test(char));
}

function scrollIndicator(line: string, width: number, caps: UiRenderCapabilities): string | undefined {
	const match = stripControls(line).match(/(?:↑|↓) \d+ more/);
	if (!match) return undefined;
	return truncateToWidth(`${BORDER.horizontal.repeat(3)} ${match[0]} `, Math.max(0, width - 2), caps.unicode ? "…" : "...");
}

function color(config: SlabConfig, caps: UiRenderCapabilities, key: "border" | "dim" | "text" | "title", text: string, focused = true): string {
	if (!caps.color) return text;
	const palette = SLAB_PALETTES[config.theme];
	if (!focused && key !== "text") return fg(palette.dim, stripControls(text));
	return fg(palette[key], text);
}

function dimStatus(status: string, state: SlabEditorState, caps: UiRenderCapabilities, focused: boolean): string {
	if (focused || !status) return status;
	return color(state.config, caps, "dim", stripControls(status), focused);
}

function titleLayout(original: string, width: number, innerWidth: number, state: SlabEditorState, caps: UiRenderCapabilities, focused: boolean): { line: string; width: number } {
	const indicator = scrollIndicator(original, width, caps);
	if (indicator) return { line: color(state.config, caps, "border", indicator, focused), width: visibleWidth(indicator) };
	if (innerWidth < 16) return { line: color(state.config, caps, "border", BORDER.horizontal, focused), width: 1 };

	const maxTitleWidth = Math.max(1, Math.min(48, Math.floor(innerWidth * 0.42)));
	const rawTitle = ` ${state.surface.workspace.name || "workspace"} `;
	const title = truncateToWidth(rawTitle, maxTitleWidth, caps.unicode ? "…" : "...");
	const line = `${color(state.config, caps, "border", BORDER.horizontal, focused)}${color(state.config, caps, "title", title, focused)}`;
	return { line, width: visibleWidth(line) };
}

function makeTopBorder(original: string, state: SlabEditorState, width: number, caps: UiRenderCapabilities, focused: boolean): string {
	const innerWidth = Math.max(0, width - 2);
	const title = titleLayout(original, width, innerWidth, state, caps, focused);
	const status = dimStatus(renderSlabLine(state.surface, state.config, Math.max(0, innerWidth - title.width - 3), caps, state.clock), state, caps, focused);
	const statusWidth = visibleWidth(status);
	const leftGap = status ? " " : "";
	const rightGap = status ? " " : "";
	const rightCap = status ? BORDER.horizontal : "";
	const fillerWidth = Math.max(0, innerWidth - title.width - visibleWidth(leftGap) - statusWidth - visibleWidth(rightGap) - visibleWidth(rightCap));
	return `${color(state.config, caps, "border", BORDER.topLeft, focused)}${title.line}${color(state.config, caps, "border", BORDER.horizontal.repeat(fillerWidth), focused)}${leftGap}${status}${rightGap}${color(state.config, caps, "border", rightCap, focused)}${color(state.config, caps, "border", BORDER.topRight, focused)}`;
}

function makeBottomBorder(original: string, state: SlabEditorState, width: number, caps: UiRenderCapabilities, focused: boolean): string {
	const indicator = scrollIndicator(original, width, caps);
	if (!indicator) return `${color(state.config, caps, "border", BORDER.bottomLeft, focused)}${color(state.config, caps, "border", BORDER.horizontal.repeat(Math.max(0, width - 2)), focused)}${color(state.config, caps, "border", BORDER.bottomRight, focused)}`;
	const innerWidth = Math.max(0, width - 2);
	const fillerWidth = Math.max(0, innerWidth - visibleWidth(indicator));
	return `${color(state.config, caps, "border", BORDER.bottomLeft, focused)}${color(state.config, caps, "border", indicator, focused)}${color(state.config, caps, "border", BORDER.horizontal.repeat(fillerWidth), focused)}${color(state.config, caps, "border", BORDER.bottomRight, focused)}`;
}

function wrapContentLine(line: string, state: SlabEditorState, width: number, caps: UiRenderCapabilities, focused: boolean): string {
	const innerWidth = Math.max(0, width - 2);
	const contentWidth = Math.max(1, innerWidth - CONTENT_PADDING_X * 2);
	const content = normalizeRenderedLine(line, contentWidth, caps);
	const padded = `${" ".repeat(CONTENT_PADDING_X)}${content}${" ".repeat(CONTENT_PADDING_X)}`;
	return `${color(state.config, caps, "border", BORDER.vertical, focused)}${ansiPadRight(padded, innerWidth)}${color(state.config, caps, "border", BORDER.vertical, focused)}`;
}

export function wrapSlabEditorLines(rawLines: string[], options: SlabEditorWrapOptions): string[] {
	const { state, capabilities: caps, focused } = options;
	if (!state.config.enabled) return rawLines.map((line) => fit(line, options.width, caps));
	const safeWidth = Math.max(4, options.width);
	if (rawLines.length < 2) return rawLines.map((line) => fit(line, safeWidth, caps));

	let bottomIndex = -1;
	for (let index = 1; index < rawLines.length; index++) {
		if (isHorizontalBorder(rawLines[index] ?? "")) bottomIndex = index;
	}
	if (bottomIndex < 1) return rawLines.map((line) => fit(line, safeWidth, caps));

	const body = rawLines.slice(1, bottomIndex);
	const autocomplete = rawLines.slice(bottomIndex + 1);
	const contentLines = body.length > 0 ? [...body] : [""];
	while (contentLines.length < state.config.editor.minContentRows) contentLines.push("");

	return [
		fit(makeTopBorder(rawLines[0] ?? "", state, safeWidth, caps, focused), safeWidth, caps),
		...contentLines.map((line) => fit(wrapContentLine(line, state, safeWidth, caps, focused), safeWidth, caps)),
		fit(makeBottomBorder(rawLines[bottomIndex] ?? "", state, safeWidth, caps, focused), safeWidth, caps),
		...autocomplete.map((line) => indentAutocompleteLine(line, safeWidth, caps)),
	];
}

function renderWidgetLines(host: UiWidgetHost, widgets: readonly UiWidgetEntry[], placement: UiWidgetEntry["placement"], width: number, caps: UiRenderCapabilities, clock: UiRenderClock): string[] {
	return host
		.renderPlacement(widgets, placement, { width, capabilities: caps, ...clock })
		.map((line) => fit(line, width, caps));
}

function capabilities(): UiRenderCapabilities {
	const lang = process.env.LC_ALL || process.env.LANG || "";
	return {
		color: process.env.NO_COLOR === undefined,
		unicode: process.env.PI_SLAB_ASCII !== "1" && lang !== "C",
	};
}

export class SlabEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getState: () => SlabEditorState,
		private readonly widgetHost: UiWidgetHost,
	) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		if (this.widgetHost.handleInput(data)) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const caps = capabilities();
		const state = this.getState();
		const safeWidth = Math.max(1, width);
		const renderWidth = Math.max(1, safeWidth - 2 - CONTENT_PADDING_X * 2);
		const rawEditor = super.render(renderWidth);
		const editorSurface = wrapSlabEditorLines(rawEditor, { state, width: safeWidth, capabilities: caps, focused: this.focused });
		const above = renderWidgetLines(this.widgetHost, state.snapshot.widgets, "aboveEditor", safeWidth, caps, state.clock);
		const below = renderWidgetLines(this.widgetHost, state.snapshot.widgets, "belowEditor", safeWidth, caps, state.clock);
		return [
			...above,
			...editorSurface,
			...below,
		];
	}
}
