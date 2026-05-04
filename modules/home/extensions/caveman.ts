/**
 * pi-caveman — why use many token when few do trick
 *
 * A pi extension that cuts ~75% of output tokens while keeping full technical
 * accuracy. Based on https://github.com/JuliusBrussee/caveman
 *
 * Commands:
 *   /caveman [level]  Toggle caveman mode or set intensity
 *   /caveman stop     Disable caveman mode (aliases: off, quit)
 *   /caveman config   Open settings dialog (default level, status bar toggle)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const LEVELS = ["off", "lite", "full", "ultra", "micro"] as const;
const STOP_ALIASES = new Set(["off", "stop", "quit"]);
type Level = (typeof LEVELS)[number];

const CAVEMAN_COMMAND_OPTIONS = [
	{ value: "lite", label: "lite", description: "Professional, no fluff" },
	{ value: "full", label: "full", description: "Classic caveman" },
	{ value: "ultra", label: "ultra", description: "Maximum compression" },
	{
		value: "micro",
		label: "micro",
		description: "Experimental prompt-minimized mode",
	},
	{ value: "off", label: "off", description: "Disable caveman mode" },
	{ value: "stop", label: "stop", description: "Disable caveman mode" },
	{ value: "quit", label: "quit", description: "Disable caveman mode" },
	{ value: "config", label: "config", description: "Open settings dialog" },
] as const;

// ---------------------------------------------------------------------------
// Persistent config (survives across sessions)
// ---------------------------------------------------------------------------

interface CavemanConfig {
	/** Level to apply on new sessions. "off" means don't auto-enable. */
	defaultLevel: Level;
	/** Whether to show the animated footer status. */
	showStatus: boolean;
}

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "caveman.json");
const CONFIG_DISPLAY_PATH = "~/.pi/agent/caveman.json";
const CAVEMAN_LEVEL_ENTRY_TYPE = "caveman-level";
const DEFAULT_CONFIG: CavemanConfig = {
	defaultLevel: "full",
	showStatus: true,
};
let saveConfigQueue: Promise<void> = Promise.resolve();

async function loadConfig(): Promise<CavemanConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw);
		return {
			defaultLevel: LEVELS.includes(parsed.defaultLevel)
				? parsed.defaultLevel
				: DEFAULT_CONFIG.defaultLevel,
			showStatus:
				typeof parsed.showStatus === "boolean"
					? parsed.showStatus
					: DEFAULT_CONFIG.showStatus,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function saveConfig(config: CavemanConfig): Promise<void> {
	const snapshot = JSON.stringify(config, null, 2) + "\n";
	saveConfigQueue = saveConfigQueue.then(async () => {
		await mkdir(CONFIG_DIR, { recursive: true });
		await writeFile(CONFIG_PATH, snapshot, "utf8");
	});
	return saveConfigQueue;
}

// ---------------------------------------------------------------------------
// Animated status bar — campfire with 256-color fire palette
// ---------------------------------------------------------------------------

interface Animation {
	frames: string[];
	label: string;
	/** ms between frames */
	interval: number;
}

const R = "\x1b[38;5;196m"; // red
const O = "\x1b[38;5;208m"; // orange
const Y = "\x1b[38;5;220m"; // yellow
const W = "\x1b[38;5;230m"; // white-hot
const E = "\x1b[38;5;52m"; // ember (dark red)
const X = "\x1b[0m"; // reset

const FIRE_FRAMES = [
	`${R}⠠${O}⠄${X}`,
	`${O}⠔${Y}⠂${X}`,
	`${Y}⠊${W}⠑${X}`,
	`${W}⠑${Y}⠊${X}`,
	`${Y}⠂${O}⠔${X}`,
	`${O}⠄${R}⠠${X}`,
	`${R}⠠${E}⠄${X}`,
	`${E}⠔${R}⠂${X}`,
];

const ANIMATIONS: Record<Exclude<Level, "off">, Animation> = {
	lite: { frames: FIRE_FRAMES, label: "LITE", interval: 300 },
	full: { frames: FIRE_FRAMES, label: "FULL", interval: 200 },
	ultra: { frames: FIRE_FRAMES, label: "ULTRA", interval: 100 },
	micro: { frames: FIRE_FRAMES, label: "MICRO", interval: 120 },
};

// ---------------------------------------------------------------------------
// System prompt fragments
// ---------------------------------------------------------------------------

const BASE = `\
IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. \
All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), \
pleasantries, hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const MICRO_PROMPT = `# Token efficiency
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].`;

const INTENSITY: Record<Exclude<Level, "off" | "micro">, string> = {
	lite: `\
No filler/hedging. Keep articles + full sentences. Professional but tight.
Example: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

	full: `\
Drop articles, fragments OK, short synonyms.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

	ultra: `\
Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y).
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."`,
};

const SAFETY = `\
Auto-clarity: drop caveman for security warnings, irreversible action confirmations, \
or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function caveman(pi: ExtensionAPI) {
	let level: Level = "off";
	let config: CavemanConfig = { ...DEFAULT_CONFIG };
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let isActive = false;
	let configLoadPromise: Promise<void> | null = null;

	const ensureConfigLoaded = async () => {
		if (!configLoadPromise) {
			configLoadPromise = (async () => {
				config = await loadConfig();
				if (level === "off" && config.defaultLevel !== "off") {
					level = config.defaultLevel;
				}
			})();
		}
		await configLoadPromise;
	};

	// -- Animation helpers --

	function stopAnimation() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
	}

	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		stopAnimation();
		const theme = ctx.ui.theme;

		if (level === "off" || !config.showStatus) {
			ctx.ui.setStatus("caveman", "");
			return;
		}

		const anim = ANIMATIONS[level];
		const setFrame = (frame: string) => {
			ctx.ui.setStatus(
				"caveman",
				frame +
					" " +
					theme.fg("muted", "caveman level: ") +
					theme.fg("text", anim.label),
			);
		};

		if (!isActive) {
			setFrame(anim.frames[0]!);
			return;
		}

		const renderFrame = () => {
			setFrame(anim.frames[frameIndex % anim.frames.length]!);
			frameIndex++;
		};

		renderFrame();
		timer = setInterval(renderFrame, anim.interval);
	}

	// -- Restore state on session load --

	pi.on("session_start", async (_event, ctx) => {
		await ensureConfigLoaded();

		let sessionLevel: Level | null = null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CAVEMAN_LEVEL_ENTRY_TYPE) {
				sessionLevel = (entry.data as { level: Level })?.level ?? null;
			}
		}

		if (sessionLevel !== null) {
			level = sessionLevel;
		} else if (config.defaultLevel !== "off") {
			level = config.defaultLevel;
			pi.appendEntry(CAVEMAN_LEVEL_ENTRY_TYPE, { level });
		}

		syncStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		isActive = true;
		syncStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		isActive = false;
		syncStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopAnimation();
		isActive = false;
	});

	// -- /caveman command --

	pi.registerCommand("caveman", {
		description:
			"Toggle caveman mode, set level, use stop/off/quit to disable, or 'config' to open settings",
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trim().toLowerCase();
			const items = CAVEMAN_COMMAND_OPTIONS.filter((item) =>
				item.value.startsWith(normalized),
			);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (arg === "config") {
				await openConfig(ctx);
				return;
			}

			if (!arg) {
				level = level === "off" ? "full" : "off";
			} else if (STOP_ALIASES.has(arg)) {
				level = "off";
			} else if (LEVELS.includes(arg as Level)) {
				level = arg as Level;
			} else {
				ctx.ui.notify(
					`Unknown: "${arg}". Use: ${LEVELS.join(", ")}, stop, quit, or config`,
					"error",
				);
				return;
			}

			pi.appendEntry(CAVEMAN_LEVEL_ENTRY_TYPE, { level });
			syncStatus(ctx);

			ctx.ui.notify(
				level === "off"
					? "Caveman mode off."
					: `Caveman: ${ANIMATIONS[level].label}`,
				"info",
			);
		},
	});

	// -- /caveman config: interactive SettingsList --

	async function openConfig(ctx: ExtensionContext) {
		await ensureConfigLoaded();

		await ctx.ui.custom((_tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "defaultLevel",
					label: "Default level for new sessions",
					currentValue: config.defaultLevel,
					values: [...LEVELS],
				},
				{
					id: "showStatus",
					label: "Show animated status bar",
					currentValue: config.showStatus ? "on" : "off",
					values: ["on", "off"],
				},
			];

			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold(" Caveman Config")), 0, 0),
			);
			container.addChild(
				new Text(theme.fg("dim", ` Saved to ${CONFIG_DISPLAY_PATH}`), 0, 0),
			);
			container.addChild(
				new Text(
					theme.fg("dim", " Default level applies to future sessions."),
					0,
					0,
				),
			);
			container.addChild(new Text("", 0, 0));

			const applySettingChange = (id: string, newValue: string) => {
				const nextConfig = { ...config };
				if (id === "defaultLevel" && LEVELS.includes(newValue as Level)) {
					nextConfig.defaultLevel = newValue as Level;
				} else if (id === "showStatus") {
					nextConfig.showStatus = newValue === "on";
				}

				if (
					nextConfig.defaultLevel === config.defaultLevel &&
					nextConfig.showStatus === config.showStatus
				) {
					return;
				}

				config = nextConfig;
				void saveConfig(config).catch((error) => {
					ctx.ui.notify(`Failed to save caveman config: ${error}`, "error");
				});
				syncStatus(ctx);
			};

			let selectedIndex = 0;
			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 10),
				getSettingsListTheme(),
				applySettingChange,
				() => done(undefined),
			);

			container.addChild(settingsList);
			container.addChild(
				new Text(
					theme.fg("dim", " ←→/hl/tab change • ↑↓/jk move • esc close"),
					0,
					0,
				),
			);

			const cycleSelectedValue = (direction: -1 | 1) => {
				const item = items[selectedIndex];
				if (!item?.values?.length) return;

				const currentIndex = item.values.indexOf(item.currentValue);
				const nextIndex =
					(currentIndex + direction + item.values.length) % item.values.length;
				const newValue = item.values[nextIndex]!;
				item.currentValue = newValue;
				settingsList.updateValue(item.id, newValue);
				applySettingChange(item.id, newValue);
			};

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (data === "j") data = "\u001b[B";
					else if (data === "k") data = "\u001b[A";

					if (data === "\u001b[B") {
						selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
					} else if (data === "\u001b[A") {
						selectedIndex = Math.max(selectedIndex - 1, 0);
					} else if (data === "h") {
						cycleSelectedValue(-1);
						_tui.requestRender();
						return;
					} else if (data === "l" || data === "\u001b[C" || data === "\t") {
						cycleSelectedValue(1);
						_tui.requestRender();
						return;
					} else if (data === "\u001b[D") {
						cycleSelectedValue(-1);
						_tui.requestRender();
						return;
					}

					settingsList.handleInput?.(data);
					_tui.requestRender();
				},
			};
		});
	}

	// -- Inject caveman rules into system prompt --

	pi.on("before_agent_start", async (event) => {
		await ensureConfigLoaded();
		if (level === "off") return;
		if (level === "micro") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${MICRO_PROMPT}`,
			};
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${BASE}\n\n${INTENSITY[level]}\n\n${SAFETY}`,
		};
	});
}
