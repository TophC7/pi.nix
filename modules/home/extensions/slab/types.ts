import type { UiRenderCapabilities, UiRenderClock, UiStatusEntry } from "@pi/lib/ui";

export type SlabSegmentId = "git" | "model" | "context" | "tokens" | "cost" | "status";
export type SlabThemeName = "light" | "dark" | "catppuccin-latte" | "catppuccin-mocha";
export type SlabIconMode = "nerd" | "plain";
export type SlabWidthMode = "full" | "compact" | "minimal";
export type SlabGitStatus = "clean" | "dirty" | "conflict" | "unknown";
export type SlabGitShaMode = "off" | "detached" | "always";
export type SlabContextDisplayMode = "percent+tokens" | "percent" | "tokens";
export type SlabContextUnknownMode = "show" | "hide";
export type SlabTokensDisplayMode = "input-output" | "total";
export type SlabTokensCacheMode = "auto" | "show" | "hide";
export type SlabModelThinkingMode = "auto" | "always" | "never";
export type SlabWorkspaceLabelMode = "name" | "smart" | "path";

export interface SlabSegmentConfig {
	id: SlabSegmentId;
	enabled: boolean;
}

export interface SlabConfig {
	version: 1;
	enabled: boolean;
	theme: SlabThemeName;
	icons: SlabIconMode;
	editor: {
		minContentRows: number;
	};
	display: {
		adaptive: boolean;
		showProvider: "auto" | "always" | "never";
		workspaceLabel: SlabWorkspaceLabelMode;
	};
	segments: SlabSegmentConfig[];
	model: {
		customNames: Record<string, string>;
		showThinking: SlabModelThinkingMode;
	};
	git: {
		showDirty: boolean;
		showAheadBehind: boolean;
		shaMode: SlabGitShaMode;
		timeoutMs: number;
		refreshDebounceMs: number;
	};
	context: {
		display: SlabContextDisplayMode;
		unknown: SlabContextUnknownMode;
	};
	cost: {
		hideZero: boolean;
	};
	tokens: {
		display: SlabTokensDisplayMode;
		cache: SlabTokensCacheMode;
	};
}

export interface SlabUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SlabGitSnapshot {
	repo: boolean;
	branch: string | null;
	detached: boolean;
	sha: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
	dirty: boolean;
	status: SlabGitStatus;
	updatedAt: number;
}

export interface SlabRuntimeState {
	workspace: {
		name: string;
		path: string;
	};
	git: SlabGitSnapshot;
	providers: {
		availableCount: number;
	};
	model: {
		id?: string;
		provider?: string;
		displayName?: string;
		thinking: string;
	};
	context: {
		tokens: number | null;
		window: number;
		percent: number | null;
	};
	usage: SlabUsageTotals;
	statuses: readonly UiStatusEntry[];
	version: number;
}

export interface SlabRgb {
	r: number;
	g: number;
	b: number;
}

export interface SlabSegmentPalette {
	fg: SlabRgb;
}

export interface SlabPalette {
	name: SlabThemeName;
	text: SlabRgb;
	dim: SlabRgb;
	warn: SlabRgb;
	error: SlabRgb;
	separator: SlabRgb;
	border: SlabRgb;
	title: SlabRgb;
	segments: Record<SlabSegmentId, SlabSegmentPalette>;
}

export type SlabIconSet = Record<SlabSegmentId, string>;

export interface SlabSegmentData {
	primary: string;
	secondary?: string;
	display?: Partial<Record<SlabWidthMode, string>>;
}

export interface SlabSegmentRenderContext {
	state: SlabRuntimeState;
	config: SlabConfig;
	widthMode: SlabWidthMode;
	icons: SlabIconSet;
	showProvider: boolean;
	render: UiRenderCapabilities & UiRenderClock & { width: number };
}

export interface SlabSegmentRenderResult {
	id: SlabSegmentId;
	text: string;
}

export interface SlabSegmentDefinition {
	id: SlabSegmentId;
	label: string;
	collect(ctx: SlabSegmentRenderContext): SlabSegmentData | undefined;
}
