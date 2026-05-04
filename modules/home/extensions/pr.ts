import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface ParsedOptions {
	model?: string;
	thinking?: ThinkingLevel;
	help: boolean;
	unknown: string[];
}

interface RestoreState {
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
}

const COMPLETIONS = [
	{ value: "--model", label: "--model", description: "Run PR creation with model, provider/model or model id" },
	{ value: "-m", label: "-m", description: "Alias for --model" },
	{ value: "--thinking", label: "--thinking", description: "Run PR creation with thinking level" },
	{ value: "-t", label: "-t", description: "Alias for --thinking" },
	{ value: "--help", label: "--help", description: "Show usage" },
] as const;

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

function parseOptions(args: string | undefined, defaultModel?: string, defaultThinking?: ThinkingLevel): ParsedOptions {
	const options: ParsedOptions = {
		model: defaultModel,
		thinking: defaultThinking,
		help: false,
		unknown: [],
	};
	const tokens = args?.trim() ? args.trim().split(/\s+/) : [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--help" || token === "-h") {
			options.help = true;
		} else if (token === "--model" || token === "-m") {
			const value = tokens[++i];
			if (value) options.model = value;
			else options.unknown.push(`${token} requires value`);
		} else if (token.startsWith("--model=")) {
			options.model = token.slice("--model=".length);
		} else if (token === "--thinking" || token === "-t") {
			const value = tokens[++i];
			if (isThinkingLevel(value)) options.thinking = value;
			else options.unknown.push(`${token} requires one of ${THINKING_LEVELS.join(", ")}`);
		} else if (token.startsWith("--thinking=")) {
			const value = token.slice("--thinking=".length);
			if (isThinkingLevel(value)) options.thinking = value;
			else options.unknown.push(`${token} invalid`);
		} else {
			options.unknown.push(token);
		}
	}

	return options;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function stringFlag(value: boolean | string | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function thinkingFlag(value: boolean | string | undefined): ThinkingLevel | undefined {
	return isThinkingLevel(value) ? value : undefined;
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

async function applyOptions(pi: ExtensionAPI, ctx: ExtensionCommandContext, options: ParsedOptions): Promise<boolean> {
	if (options.model) {
		const model = resolveModel(ctx, options.model);
		if (model === "ambiguous") {
			const matches = ctx.modelRegistry
				.getAll()
				.filter((candidate) => `${candidate.provider}/${candidate.id}`.includes(options.model!) || candidate.id.includes(options.model!))
				.slice(0, 5)
				.map((candidate) => `${candidate.provider}/${candidate.id}`)
				.join(", ");
			ctx.ui.notify(`Ambiguous model "${options.model}". Matches: ${matches}`, "error");
			return false;
		}
		if (!model) {
			ctx.ui.notify(`Model not found: ${options.model}`, "error");
			return false;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "error");
			return false;
		}
	}

	if (options.thinking) {
		pi.setThinkingLevel(options.thinking);
	}

	return true;
}

export default function prExtension(pi: ExtensionAPI) {
	let pendingRestore: RestoreState | undefined;

	pi.registerFlag("pr-model", {
		description: "Default model for /pr, provider/model or model id",
		type: "string",
	});
	pi.registerFlag("pr-thinking", {
		description: "Default thinking level for /pr",
		type: "string",
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingRestore) return;
		const restore = pendingRestore;
		pendingRestore = undefined;
		if (restore.model) await pi.setModel(restore.model);
		pi.setThinkingLevel(restore.thinking);
		ctx.ui.notify("/pr model restored", "info");
	});

	pi.registerCommand("pr", {
		description: "Create PR. Options: --model <provider/model> --thinking <level>",
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trim();
			const items = COMPLETIONS.filter((item) => item.value.startsWith(normalized));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const options = parseOptions(
				args,
				stringFlag(pi.getFlag("pr-model")),
				thinkingFlag(pi.getFlag("pr-thinking")),
			);

			if (options.help) {
				ctx.ui.notify("Usage: /pr [--model provider/model] [--thinking off|minimal|low|medium|high|xhigh]", "info");
				return;
			}
			if (options.unknown.length > 0) {
				ctx.ui.notify(`Unknown /pr args: ${options.unknown.join(", ")}`, "error");
				return;
			}

			await ctx.waitForIdle();
			const shouldRestore = Boolean(options.model || options.thinking);
			if (shouldRestore) {
				pendingRestore = { model: ctx.model, thinking: pi.getThinkingLevel() };
			}
			if (!(await applyOptions(pi, ctx, options))) {
				pendingRestore = undefined;
				return;
			}
			pi.sendUserMessage(PR_PROMPT);
		},
	});
}
