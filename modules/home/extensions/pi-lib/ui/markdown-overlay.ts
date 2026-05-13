import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Key, Markdown, Spacer, Text, matchesKey, type Component, type MarkdownTheme } from "@mariozechner/pi-tui";
import { centeredOverlayOptions } from "./layout.ts";

export interface OverlayHandle {
	hide(): void;
	isHidden(): boolean;
}

export interface MarkdownOverlayOptions {
	title: string;
	markdown: string;
	width?: number | `${number}%`;
	maxHeight?: number | `${number}%`;
}

class MarkdownOverlay extends Container implements Component {
	constructor(
		theme: Theme,
		title: string,
		markdown: string,
		private readonly close: () => void,
	) {
		super();
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Text(theme.fg("dim", "Esc closes"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Markdown(markdown, 1, 0, resolveMarkdownTheme()));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.close();
	}
}

export function resolveMarkdownTheme(): MarkdownTheme {
	try {
		const theme = getMarkdownTheme();
		theme.heading("probe");
		return theme;
	} catch {
		const identity = (text: string) => text;
		return {
			heading: identity,
			link: identity,
			linkUrl: identity,
			code: identity,
			codeBlock: identity,
			codeBlockBorder: identity,
			quote: identity,
			quoteBorder: identity,
			hr: identity,
			listBullet: identity,
			bold: identity,
			italic: identity,
			strikethrough: identity,
			underline: identity,
		};
	}
}

export function showMarkdownOverlay(
	ctx: ExtensionCommandContext,
	options: MarkdownOverlayOptions,
): OverlayHandle {
	let close: (() => void) | undefined;
	let closed = false;

	const finish = () => {
		if (closed) return;
		closed = true;
		close?.();
	};

	void ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => {
			close = () => done(undefined);
			if (closed) queueMicrotask(close);
			return new MarkdownOverlay(theme, options.title, options.markdown, finish);
		},
		centeredOverlayOptions({
			width: options.width,
			maxHeight: options.maxHeight,
		}),
	).catch((error) => {
		ctx.ui.notify(`Markdown overlay failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	});

	return {
		hide: finish,
		isHidden: () => closed,
	};
}
