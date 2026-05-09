import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { fuzzyFilter } from "@mariozechner/pi-tui";
import { prepareManualHandoff, unsafeAutomaticHandoffReason } from "../workflow/handoff.ts";

export type GitAction = "commit" | "pr";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CommandConfig {
	model?: string;
	thinking?: ThinkingLevel;
}

type ConfigFile = Record<string, unknown> & { git?: CommandConfig };

interface RestoreState {
	action: GitAction;
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
}

export const CONFIG_PATH = process.env.PI_COMMAND_MODELS_CONFIG ?? join(process.env.HOME ?? ".", ".pi", "agent", "command-models.json");

let pendingRestore: RestoreState | undefined;
const installed = new WeakSet<ExtensionAPI>();

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function readConfig(): ConfigFile {
	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return typeof config === "object" && config !== null && !Array.isArray(config) ? config as ConfigFile : {};
	} catch {
		return {};
	}
}

function writeConfig(config: ConfigFile): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`);
}

function sanitizeConfig(config: unknown): CommandConfig {
	if (typeof config !== "object" || config === null || Array.isArray(config)) return {};
	const candidate = config as CommandConfig;
	return {
		model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : undefined,
		thinking: isThinkingLevel(candidate.thinking) ? candidate.thinking : undefined,
	};
}

export function getGitConfig(): CommandConfig {
	return sanitizeConfig(readConfig().git);
}

export function saveGitConfig(git: CommandConfig): void {
	const config = readConfig();
	config.git = git;
	delete config.commit;
	delete config.pr;
	writeConfig(config);
}

export function resolveModel(ctx: ExtensionCommandContext, spec: string): Model<Api> | undefined | "ambiguous" {
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

	const fuzzy = fuzzyFilter(models, spec, (model) => `${model.id} ${model.provider} ${model.provider}/${model.id} ${model.name ?? ""}`);
	if (fuzzy.length === 1) return fuzzy[0];
	if (fuzzy.length > 1) return "ambiguous";
	return undefined;
}

async function applyGitActionConfig(pi: ExtensionAPI, ctx: ExtensionCommandContext, config: CommandConfig): Promise<boolean> {
	if (config.model) {
		const model = resolveModel(ctx, config.model);
		if (model === "ambiguous") {
			ctx.ui.notify(`Ambiguous /git model in ${CONFIG_PATH}: ${config.model}`, "error");
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

async function restoreGitActionConfig(pi: ExtensionAPI, restore: RestoreState | undefined): Promise<void> {
	if (!restore) return;
	if (restore.model) await pi.setModel(restore.model);
	pi.setThinkingLevel(restore.thinking);
}

function buildPrompt(action: GitAction, basePrompt: string, userPrompt: string | undefined): string {
	const trimmed = userPrompt?.trim();
	if (!trimmed) return basePrompt;
	return `${basePrompt}\n\nAdditional user instructions from /${action} prompt. Follow only when they do not conflict with rules above:\n${trimmed}`;
}

export function formatConfigStatus(config: CommandConfig): string {
	return [
		"/git config",
		`model: ${config.model ?? "default"}`,
		`thinking: ${config.thinking ?? "default"}`,
		`config: ${CONFIG_PATH}`,
	].join("\n");
}

export function installGitActionRuntime(pi: ExtensionAPI): void {
	if (installed.has(pi)) return;
	installed.add(pi);

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingRestore) return;
		const restore = pendingRestore;
		pendingRestore = undefined;
		if (restore.model) await pi.setModel(restore.model);
		pi.setThinkingLevel(restore.thinking);
		ctx.ui.notify(`/${restore.action} config restored`, "info");
	});
}

export async function runGitAction(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	action: GitAction,
	basePrompt: string,
	userPrompt?: string,
): Promise<void> {
	installGitActionRuntime(pi);
	await ctx.waitForIdle();

	const config = getGitConfig();
	const shouldRestore = Boolean(config.model || config.thinking);
	if (shouldRestore) {
		pendingRestore = { action, model: ctx.model, thinking: pi.getThinkingLevel() };
	}
	if (!(await applyGitActionConfig(pi, ctx, config))) {
		pendingRestore = undefined;
		return;
	}

	const restore = pendingRestore;
	await prepareManualHandoff(ctx, {
		label: `/${action}`,
		command: buildPrompt(action, basePrompt, userPrompt),
		reason: `${unsafeAutomaticHandoffReason()} Model/thinking config is not kept pending during manual handoff; re-run after accepting if a custom /git model is required.`,
	}, { pi });
	pendingRestore = undefined;
	await restoreGitActionConfig(pi, restore);
}
