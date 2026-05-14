import {
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, type Component } from "@mariozechner/pi-tui";
import {
	createUiRenderDriver,
	getUiStatusStore,
	openDialog,
	renderFooterBridgeLines,
	UiWidgetHost,
	type UiRenderCapabilities,
	type UiRenderClock,
	type UiRenderDriverHandle,
	type UiSnapshot,
	type UiWidgetEntry,
} from "@pi/lib/ui";
import { defaultSlabConfig, loadSlabConfig, saveSlabConfig } from "./config.ts";
import { SlabEditor } from "./editor.ts";
import { collectGitSnapshot } from "./git.ts";
import { SlabConfigPane, type SlabPaneResult } from "./pane.ts";
import { createSlabRuntimeState } from "./state.ts";
import type { SlabConfig, SlabGitSnapshot, SlabRuntimeState } from "./types.ts";

export const SLAB_EXTENSION_NAME = "slab" as const;

const REDRAW_THROTTLE_MS = 60;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

interface SlabState {
	config: SlabConfig;
	surface: SlabRuntimeState;
	snapshot: UiSnapshot;
	clock: UiRenderClock;
}

function createState(ctx: ExtensionContext, config: SlabConfig, snapshot = getUiStatusStore().snapshot(), clock: UiRenderClock = { now: Date.now(), tick: 0 }, git?: SlabGitSnapshot): SlabState {
	return {
		config,
		surface: createSlabRuntimeState(ctx, snapshot, clock, config, { git }),
		snapshot,
		clock,
	};
}

function capabilities(): UiRenderCapabilities {
	const lang = process.env.LC_ALL || process.env.LANG || "";
	return {
		color: process.env.NO_COLOR === undefined,
		unicode: process.env.PI_SLAB_ASCII !== "1" && lang !== "C",
	};
}

function clean(text: string, caps: UiRenderCapabilities): string {
	return caps.color ? text : text.replace(ANSI_PATTERN, "");
}

function fit(text: string, width: number, caps: UiRenderCapabilities): string {
	return truncateToWidth(clean(text, caps), Math.max(0, width), caps.unicode ? "…" : "...");
}

function renderWidgetLines(host: UiWidgetHost, widgets: readonly UiWidgetEntry[], placement: UiWidgetEntry["placement"], width: number, caps: UiRenderCapabilities, clock: UiRenderClock): string[] {
	return host
		.renderPlacement(widgets, placement, { width, capabilities: caps, ...clock })
		.map((line) => fit(line, width, caps));
}

class SlabFooter implements Component {
	constructor(
		private readonly footerData: ReadonlyFooterDataProvider,
		private readonly getState: () => SlabState,
		private readonly widgetHost: UiWidgetHost,
	) {}

	render(width: number): string[] {
		const caps = capabilities();
		const state = this.getState();
		const widgetLines = renderWidgetLines(this.widgetHost, state.snapshot.widgets, "footer", width, caps, state.clock);
		return renderFooterBridgeLines(widgetLines, this.footerData.getExtensionStatuses().values(), width, caps);
	}

	invalidate(): void {}

	dispose(): void {}
}

export default function slab(pi: ExtensionAPI): void {
	let config = defaultSlabConfig();
	let currentCtx: ExtensionContext | undefined;
	let gitSnapshot: SlabGitSnapshot | undefined;
	let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let gitRefreshInFlightCwd: string | undefined;
	let gitRefreshQueuedCtx: ExtensionContext | undefined;
	let gitRefreshGeneration = 0;
	let state: SlabState | undefined;
	let driver: UiRenderDriverHandle | undefined;
	let widgetHost: UiWidgetHost | undefined;
	let renderRequested = false;
	let requestRender = () => {
		renderRequested = true;
	};

	function getState(): SlabState {
		if (!state) throw new Error("slab state not initialized");
		return state;
	}

	function refresh(ctx: ExtensionContext): void {
		currentCtx = ctx;
		const snapshot = getUiStatusStore().snapshot();
		const clock = driver?.clock ?? state?.clock ?? { now: Date.now(), tick: 0 };
		state = createState(ctx, config, snapshot, clock, gitSnapshot);
		driver?.request();
	}

	function requestGitRefresh(ctx: ExtensionContext): void {
		gitRefreshQueuedCtx = ctx;
		if (gitRefreshTimer || gitRefreshInFlightCwd) return;
		gitRefreshTimer = setTimeout(() => {
			gitRefreshTimer = undefined;
			const next = gitRefreshQueuedCtx;
			gitRefreshQueuedCtx = undefined;
			if (next) void runGitRefresh(next, gitRefreshGeneration);
		}, Math.max(0, config.git.refreshDebounceMs));
	}

	async function runGitRefresh(ctx: ExtensionContext, generation: number): Promise<void> {
		const cwd = ctx.cwd;
		gitRefreshInFlightCwd = cwd;
		try {
			const snapshot = await collectGitSnapshot(cwd, config.git);
			if (generation !== gitRefreshGeneration || currentCtx?.cwd !== cwd) return;
			gitSnapshot = snapshot;
			refresh(ctx);
		} finally {
			gitRefreshInFlightCwd = undefined;
			const next = gitRefreshQueuedCtx;
			gitRefreshQueuedCtx = undefined;
			if (next && generation === gitRefreshGeneration) requestGitRefresh(next);
		}
	}

	async function install(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		clear(ctx);
		config = await loadSlabConfig();
		if (!config.enabled) return;
		currentCtx = ctx;
		gitSnapshot = undefined;
		state = createState(ctx, config);
		widgetHost = new UiWidgetHost({ onInvalidate: () => requestRender() });
		driver = createUiRenderDriver({
			store: getUiStatusStore(),
			throttleMs: REDRAW_THROTTLE_MS,
			render(clock, snapshot) {
				if (currentCtx) state = createState(currentCtx, config, snapshot, clock, gitSnapshot);
				requestRender();
			},
		});
		requestGitRefresh(ctx);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			if (renderRequested) {
				renderRequested = false;
				requestRender();
			}
			if (!widgetHost) throw new Error("slab widget host not initialized");
			return new SlabFooter(footerData, getState, widgetHost);
		});
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			if (renderRequested) {
				renderRequested = false;
				requestRender();
			}
			if (!widgetHost) throw new Error("slab widget host not initialized");
			return new SlabEditor(tui, theme, keybindings, getState, widgetHost);
		});
	}

	function clear(ctx: ExtensionContext): void {
		driver?.dispose();
		driver = undefined;
		if (ctx.hasUI) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
		}
		widgetHost?.dispose();
		widgetHost = undefined;
		currentCtx = undefined;
		gitSnapshot = undefined;
		gitRefreshGeneration++;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		gitRefreshInFlightCwd = undefined;
		gitRefreshQueuedCtx = undefined;
	}

	pi.registerCommand("slab", {
		description: "Configure the slab input surface.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/slab requires interactive UI", "warning");
				return;
			}
			const initial = await loadSlabConfig();
			const result = await new Promise<SlabPaneResult>((resolve) => {
				openDialog(
					ctx,
					({ theme, close }) => new SlabConfigPane(initial, theme, (next) => {
						resolve(next);
						close();
					}),
					{ width: "96%", maxHeight: "94%", padding: 0, borderStyle: "square" },
				);
			});
			if (result.action !== "save") return;
			await saveSlabConfig(result.config);
			config = result.config;
			await install(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await install(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refresh(ctx);
		requestGitRefresh(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		refresh(ctx);
		requestGitRefresh(ctx);
	});

	pi.on("message_end", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		refresh(ctx);
		requestGitRefresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refresh(ctx);
		requestGitRefresh(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clear(ctx);
		state = undefined;
	});
}
