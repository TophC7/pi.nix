import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { selectModelFromMenu, selectThinkingFromMenu } from "./model-picker";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface CommandConfig {
	model?: string;
	thinking?: ThinkingLevel;
}

interface CommandsConfig {
	commit?: CommandConfig;
	pr?: CommandConfig;
}

interface ParsedCommand {
	action: "run" | "model" | "thinking" | "reset" | "help";
	unknown?: string;
}

interface RestoreState {
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
}

const COMPLETIONS = [
	{ value: "model", label: "model", description: "Pick and save /commit model" },
	{ value: "thinking", label: "thinking", description: "Pick and save /commit thinking level" },
	{ value: "reset", label: "reset", description: "Clear saved /commit model config" },
	{ value: "help", label: "help", description: "Show usage" },
] as const;

const CONFIG_PATH = process.env.PI_COMMAND_MODELS_CONFIG ?? join(process.env.HOME ?? ".", ".pi", "agent", "command-models.json");

const COMMIT_PROMPT = `Create a conventional commit from currently staged git changes.

Workflow:
1. Run \`git diff --cached --stat\` and \`git diff --cached\`.
2. If nothing is staged, tell the user and stop.
3. Draft a conventional commit message from the staged diff only.
   - First line: \`type(scope): summary\`
   - Keep summary under 72 characters.
   - Use best type: feat, fix, refactor, chore, docs, style, test, perf, ci, build.
   - Scope optional; include only when useful.
   - Add short body bullets only for multiple notable changes.
   - Do not include trailers.
4. Create the commit once, non-interactively, with fish syntax:

\`\`\`fish
set commit_message (string join \\n -- "type(scope): summary line" "" "- important detail 1" "- important detail 2" | string collect)

git commit -m "$commit_message"
\`\`\`

Rules:
- Commit only already-staged changes.
- Do not edit files, stage files, unstage files, amend, retry, or bypass hooks.
- If commit fails, show error output and exact attempted commit message, then stop.
- If commit succeeds, show commit hash and summary briefly.`;

function parseCommand(args: string | undefined): ParsedCommand {
	const value = args?.trim();
	if (!value) return { action: "run" };
	if (value === "model") return { action: "model" };
	if (value === "thinking") return { action: "thinking" };
	if (value === "reset") return { action: "reset" };
	if (value === "help" || value === "--help" || value === "-h") return { action: "help" };
	return { action: "run", unknown: value };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function readConfig(): CommandsConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CommandsConfig;
		return typeof config === "object" && config !== null ? config : {};
	} catch {
		return {};
	}
}

function writeConfig(config: CommandsConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`);
}

function getCommitConfig(): CommandConfig {
	const config = readConfig().commit ?? {};
	return {
		model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined,
		thinking: isThinkingLevel(config.thinking) ? config.thinking : undefined,
	};
}

function saveCommitConfig(commit: CommandConfig): void {
	const config = readConfig();
	config.commit = commit;
	writeConfig(config);
}

function resolveModel(ctx: ExtensionCommandContext, spec: string): Model<Api> | undefined | "ambiguous" {
	const models = ctx.modelRegistry.getAll();
	const exactFull = models.find((model) => `${model.provider}/${model.id}` === spec);
	if (exactFull) return exactFull;

	const slash = spec.indexOf("/");
	if (slash > 0) {
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		const exactProvider = ctx.modelRegistry.find(provider, id);
		if (exactProvider) return exactProvider;
	}

	const exactId = models.filter((model) => model.id === spec || model.name === spec);
	if (exactId.length === 1) return exactId[0];
	if (exactId.length > 1) return "ambiguous";

	const lower = spec.toLowerCase();
	const fuzzy = models.filter((model) =>
		`${model.provider}/${model.id}`.toLowerCase().includes(lower) ||
		model.id.toLowerCase().includes(lower) ||
		model.name.toLowerCase().includes(lower),
	);
	if (fuzzy.length === 1) return fuzzy[0];
	if (fuzzy.length > 1) return "ambiguous";
	return undefined;
}

async function applyConfig(pi: ExtensionAPI, ctx: ExtensionCommandContext, config: CommandConfig): Promise<boolean> {
	if (config.model) {
		const model = resolveModel(ctx, config.model);
		if (model === "ambiguous") {
			ctx.ui.notify(`Ambiguous /commit model in ${CONFIG_PATH}: ${config.model}`, "error");
			return false;
		}
		if (!model) {
			ctx.ui.notify(`Model not found in ${CONFIG_PATH}: ${config.model}`, "error");
			return false;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "error");
			return false;
		}
	}

	if (config.thinking) {
		pi.setThinkingLevel(config.thinking);
	}

	return true;
}

export default function commitExtension(pi: ExtensionAPI) {
	let pendingRestore: RestoreState | undefined;

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingRestore) return;
		const restore = pendingRestore;
		pendingRestore = undefined;
		if (restore.model) await pi.setModel(restore.model);
		pi.setThinkingLevel(restore.thinking);
		ctx.ui.notify("/commit model restored", "info");
	});

	pi.registerCommand("commit", {
		description: "Commit staged changes. Use `/commit model` to pick saved model.",
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trim();
			const items = COMPLETIONS.filter((item) => item.value.startsWith(normalized));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = parseCommand(args);
			const config = getCommitConfig();

			if (command.action === "help") {
				ctx.ui.notify(`Usage: /commit | /commit model | /commit thinking | /commit reset\nConfig: ${CONFIG_PATH}`, "info");
				return;
			}
			if (command.unknown) {
				ctx.ui.notify(`Unknown /commit arg: ${command.unknown}. Use /commit help.`, "error");
				return;
			}
			if (command.action === "model") {
				const model = await selectModelFromMenu(ctx, "Pick /commit model:", config.model);
				if (!model) return;
				saveCommitConfig({ ...config, model });
				ctx.ui.notify(`Saved /commit model: ${model}`, "info");
				return;
			}
			if (command.action === "thinking") {
				const thinking = await selectThinkingFromMenu(ctx, "Pick /commit thinking:", config.thinking);
				if (!thinking) return;
				saveCommitConfig({ ...config, thinking });
				ctx.ui.notify(`Saved /commit thinking: ${thinking}`, "info");
				return;
			}
			if (command.action === "reset") {
				saveCommitConfig({});
				ctx.ui.notify("Cleared /commit model config", "info");
				return;
			}

			await ctx.waitForIdle();
			const shouldRestore = Boolean(config.model || config.thinking);
			if (shouldRestore) {
				pendingRestore = { model: ctx.model, thinking: pi.getThinkingLevel() };
			}
			if (!(await applyConfig(pi, ctx, config))) {
				pendingRestore = undefined;
				return;
			}
			pi.sendUserMessage(COMMIT_PROMPT);
		},
	});
}
