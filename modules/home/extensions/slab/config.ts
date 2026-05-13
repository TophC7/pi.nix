import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type {
	SlabConfig,
	SlabContextDisplayMode,
	SlabContextUnknownMode,
	SlabGitShaMode,
	SlabIconMode,
	SlabModelThinkingMode,
	SlabSegmentConfig,
	SlabSegmentId,
	SlabThemeName,
	SlabTokensCacheMode,
	SlabTokensDisplayMode,
	SlabWorkspaceLabelMode,
} from "./types.ts";

export const SLAB_CONFIG_VERSION = 1 as const;

export const DEFAULT_SLAB_SEGMENTS: SlabSegmentConfig[] = [
	{ id: "git", enabled: true },
	{ id: "context", enabled: true },
	{ id: "cost", enabled: true },
	{ id: "tokens", enabled: false },
	{ id: "status", enabled: true },
	{ id: "model", enabled: true },
];

export const SLAB_SEGMENT_IDS = new Set<SlabSegmentId>(DEFAULT_SLAB_SEGMENTS.map((segment) => segment.id));

const THEMES = new Set<SlabThemeName>(["light", "dark", "catppuccin-latte", "catppuccin-mocha"]);
const ICON_MODES = new Set<SlabIconMode>(["nerd", "plain"]);
const PROVIDER_MODES = new Set<SlabConfig["display"]["showProvider"]>(["auto", "always", "never"]);
const WORKSPACE_LABEL_MODES = new Set<SlabWorkspaceLabelMode>(["name", "smart", "path"]);
const GIT_SHA_MODES = new Set<SlabGitShaMode>(["off", "detached", "always"]);
const CONTEXT_DISPLAY_MODES = new Set<SlabContextDisplayMode>(["percent+tokens", "percent", "tokens"]);
const CONTEXT_UNKNOWN_MODES = new Set<SlabContextUnknownMode>(["show", "hide"]);
const TOKENS_DISPLAY_MODES = new Set<SlabTokensDisplayMode>(["input-output", "total"]);
const TOKENS_CACHE_MODES = new Set<SlabTokensCacheMode>(["auto", "show", "hide"]);
const MODEL_THINKING_MODES = new Set<SlabModelThinkingMode>(["auto", "always", "never"]);

export function slabConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "slab", "config.json");
}

export function defaultSlabConfig(): SlabConfig {
	return {
		version: SLAB_CONFIG_VERSION,
		enabled: true,
		theme: "light",
		icons: "plain",
		editor: {
			minContentRows: 3,
		},
		display: {
			adaptive: true,
			showProvider: "auto",
			workspaceLabel: "name",
		},
		segments: DEFAULT_SLAB_SEGMENTS.map((segment) => ({ ...segment })),
		model: {
			customNames: {},
			showThinking: "auto",
		},
		git: {
			showDirty: true,
			showAheadBehind: true,
			shaMode: "off",
			timeoutMs: 1000,
			refreshDebounceMs: 1500,
		},
		context: {
			display: "percent+tokens",
			unknown: "show",
		},
		cost: {
			hideZero: false,
		},
		tokens: {
			display: "input-output",
			cache: "auto",
		},
	};
}

export function cloneSlabConfig(config: SlabConfig): SlabConfig {
	return {
		...config,
		editor: { ...config.editor },
		display: { ...config.display },
		segments: config.segments.map((segment) => ({ ...segment })),
		model: { customNames: { ...config.model.customNames }, showThinking: config.model.showThinking },
		git: { ...config.git },
		context: { ...config.context },
		cost: { ...config.cost },
		tokens: { ...config.tokens },
	};
}

export function moveSlabSegment(config: SlabConfig, id: SlabSegmentId, direction: -1 | 1): SlabConfig {
	const next = cloneSlabConfig(config);
	const index = next.segments.findIndex((segment) => segment.id === id);
	const target = index + direction;
	if (index < 0 || target < 0 || target >= next.segments.length) return next;
	[next.segments[index], next.segments[target]] = [next.segments[target]!, next.segments[index]!];
	return next;
}

export function toggleSlabSegment(config: SlabConfig, id: SlabSegmentId): SlabConfig {
	const next = cloneSlabConfig(config);
	const segment = next.segments.find((item) => item.id === id);
	if (segment) segment.enabled = !segment.enabled;
	return next;
}

function parseBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function parseStringEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
	return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

function parseIntInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseIntAtLeast(value: unknown, fallback: number, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.floor(value));
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeSegments(value: unknown): SlabSegmentConfig[] {
	const defaults = DEFAULT_SLAB_SEGMENTS.map((segment) => ({ ...segment }));
	const byId = new Map<SlabSegmentId, SlabSegmentConfig>(defaults.map((segment) => [segment.id, segment]));
	const ordered: SlabSegmentConfig[] = [];

	if (Array.isArray(value)) {
		for (const raw of value) {
			const record = object(raw);
			if (typeof record.id !== "string" || !SLAB_SEGMENT_IDS.has(record.id as SlabSegmentId)) continue;
			const id = record.id as SlabSegmentId;
			const base = byId.get(id)!;
			const segment = { id, enabled: parseBool(record.enabled, base.enabled) };
			byId.set(id, segment);
			if (!ordered.some((item) => item.id === id)) ordered.push(segment);
		}
	}

	for (const segment of defaults) {
		if (!ordered.some((item) => item.id === segment.id)) ordered.push(byId.get(segment.id)!);
	}
	return ordered;
}

export function normalizeSlabConfig(raw: unknown): SlabConfig {
	const defaults = defaultSlabConfig();
	const record = object(raw);
	const editor = object(record.editor);
	const display = object(record.display);
	const model = object(record.model);
	const git = object(record.git);
	const context = object(record.context);
	const cost = object(record.cost);
	const tokens = object(record.tokens);
	const customNames = object(model.customNames);

	return {
		version: SLAB_CONFIG_VERSION,
		enabled: parseBool(record.enabled, defaults.enabled),
		theme: parseStringEnum(record.theme, THEMES, defaults.theme),
		icons: parseStringEnum(record.icons, ICON_MODES, defaults.icons),
		editor: {
			minContentRows: parseIntInRange(editor.minContentRows, defaults.editor.minContentRows, 2, 4),
		},
		display: {
			adaptive: parseBool(display.adaptive, defaults.display.adaptive),
			showProvider: parseStringEnum(display.showProvider, PROVIDER_MODES, defaults.display.showProvider),
			workspaceLabel: parseStringEnum(display.workspaceLabel, WORKSPACE_LABEL_MODES, defaults.display.workspaceLabel),
		},
		segments: normalizeSegments(record.segments),
		model: {
			customNames: Object.fromEntries(Object.entries(customNames).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
			showThinking: parseStringEnum(model.showThinking, MODEL_THINKING_MODES, defaults.model.showThinking),
		},
		git: {
			showDirty: parseBool(git.showDirty, defaults.git.showDirty),
			showAheadBehind: parseBool(git.showAheadBehind, defaults.git.showAheadBehind),
			shaMode: parseStringEnum(git.shaMode, GIT_SHA_MODES, defaults.git.shaMode),
			timeoutMs: parseIntAtLeast(git.timeoutMs, defaults.git.timeoutMs, 100),
			refreshDebounceMs: parseIntAtLeast(git.refreshDebounceMs, defaults.git.refreshDebounceMs, 0),
		},
		context: {
			display: parseStringEnum(context.display, CONTEXT_DISPLAY_MODES, defaults.context.display),
			unknown: parseStringEnum(context.unknown, CONTEXT_UNKNOWN_MODES, defaults.context.unknown),
		},
		cost: {
			hideZero: parseBool(cost.hideZero, defaults.cost.hideZero),
		},
		tokens: {
			display: parseStringEnum(tokens.display, TOKENS_DISPLAY_MODES, defaults.tokens.display),
			cache: parseStringEnum(tokens.cache, TOKENS_CACHE_MODES, defaults.tokens.cache),
		},
	};
}

export async function loadSlabConfig(path = slabConfigPath()): Promise<SlabConfig> {
	let exists = false;
	try {
		const fileStat = await stat(path);
		exists = fileStat.isFile();
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT") throw error;
	}
	if (!exists) return defaultSlabConfig();
	const text = await readFile(path, "utf8");
	return normalizeSlabConfig(JSON.parse(text));
}

export async function saveSlabConfig(config: SlabConfig, path = slabConfigPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(normalizeSlabConfig(config), null, "\t")}\n`, "utf8");
}
