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
	{ value: "model", label: "model", description: "Pick and save /pr model" },
	{ value: "thinking", label: "thinking", description: "Pick and save /pr thinking level" },
	{ value: "reset", label: "reset", description: "Clear saved /pr model config" },
	{ value: "help", label: "help", description: "Show usage" },
] as const;

const CONFIG_PATH = process.env.PI_COMMAND_MODELS_CONFIG ?? join(process.env.HOME ?? ".", ".pi", "agent", "command-models.json");

const PR_PROMPT = `Create a pull request from the current branch's committed and pushed changes.

Workflow:
1. Inspect branch state:
   - \`git branch --show-current\`
   - \`git log --oneline main..HEAD\`
   - \`git diff main...HEAD --stat\`
   - \`git status --short\`
   - \`git rev-parse --abbrev-ref @{upstream} 2>/dev/null\`
2. If no commits exist between \`main\` and \`HEAD\`, tell the user and stop.
3. If uncommitted changes exist, warn briefly, but use committed diff only.
4. Decide PR branch:
   - Treat \`dev/*\` branches as local-only.
   - Never push \`dev/*\`.
   - From \`dev/*\`, create a concise PR branch pointer at current committed HEAD with \`git branch <pr-branch-name>\`, without checking it out.
   - Otherwise use current branch as PR branch.
5. Ensure PR branch is pushed:
   - \`git push -u origin <pr-branch-name>\`
   - If PR creation fails because remote branch is missing or stale, push once and retry PR creation once.
6. Draft PR title and body from all commits and \`main...HEAD\` diff summary.
   - Title: concise conventional-style, under 70 characters.
   - Body format exactly:

\`\`\`md
## Summary
- bullet 1
- bullet 2
\`\`\`

7. Create PR once with explicit head:

\`\`\`fish
set pr_body (string join \\n -- "## Summary" "- bullet 1" "- bullet 2" | string collect)

gh pr create --head "<pr-branch-name>" --title "the title" --body "$pr_body"
\`\`\`

Rules:
- Base PR on committed changes only.
- Do not edit files, create commits, amend commits, or fix branch state beyond allowed push.
- Do not include Test plan, Testing, or How to test sections.
- If PR creation fails after allowed push-and-retry, show error output plus exact title and body attempted, then stop.
- If PR succeeds, return PR URL only.`;

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

function getPrConfig(): CommandConfig {
	const config = readConfig().pr ?? {};
	return {
		model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined,
		thinking: isThinkingLevel(config.thinking) ? config.thinking : undefined,
	};
}

function savePrConfig(pr: CommandConfig): void {
	const config = readConfig();
	config.pr = pr;
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
			ctx.ui.notify(`Ambiguous /pr model in ${CONFIG_PATH}: ${config.model}`, "error");
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

export default function prExtension(pi: ExtensionAPI) {
	let pendingRestore: RestoreState | undefined;

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingRestore) return;
		const restore = pendingRestore;
		pendingRestore = undefined;
		if (restore.model) await pi.setModel(restore.model);
		pi.setThinkingLevel(restore.thinking);
		ctx.ui.notify("/pr model restored", "info");
	});

	pi.registerCommand("pr", {
		description: "Create PR. Use `/pr model` to pick saved model.",
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trim();
			const items = COMPLETIONS.filter((item) => item.value.startsWith(normalized));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = parseCommand(args);
			const config = getPrConfig();

			if (command.action === "help") {
				ctx.ui.notify(`Usage: /pr | /pr model | /pr thinking | /pr reset\nConfig: ${CONFIG_PATH}`, "info");
				return;
			}
			if (command.unknown) {
				ctx.ui.notify(`Unknown /pr arg: ${command.unknown}. Use /pr help.`, "error");
				return;
			}
			if (command.action === "model") {
				const model = await selectModelFromMenu(ctx, "Pick /pr model:", config.model);
				if (!model) return;
				savePrConfig({ ...config, model });
				ctx.ui.notify(`Saved /pr model: ${model}`, "info");
				return;
			}
			if (command.action === "thinking") {
				const thinking = await selectThinkingFromMenu(ctx, "Pick /pr thinking:", config.thinking);
				if (!thinking) return;
				savePrConfig({ ...config, thinking });
				ctx.ui.notify(`Saved /pr thinking: ${thinking}`, "info");
				return;
			}
			if (command.action === "reset") {
				savePrConfig({});
				ctx.ui.notify("Cleared /pr model config", "info");
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
			pi.sendUserMessage(PR_PROMPT);
		},
	});
}
