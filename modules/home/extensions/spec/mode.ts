import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Mode, ModeState } from "./types.ts";

const INSPECTION_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"ask_user",
	"AskClaude",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
];

const AUTHORING_TOOLS = [
	...INSPECTION_TOOLS,
	"save_plan_draft",
	"save_spec",
	"trekker",
];

const MUTATING_BASH = [
	/\brm\b/,
	/\bmv\b/,
	/\bcp\b/,
	/\bmkdir\b/,
	/\btouch\b/,
	/\bgit\s+(add|commit|push|reset|checkout|switch|merge|rebase|clean|stash)\b/,
	/>|>>|\d>/,
	/\|\s*xargs\b/,
	/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/,
];

export const state: ModeState = { mode: "idle" };


function availableToolNames(pi: ExtensionAPI, names: string[]): string[] {
	const all = new Set(pi.getAllTools().map((tool) => tool.name));
	return names.filter((name) => all.has(name));
}

export function setWorkflowStatus(ctx: ExtensionContext, mode: Mode): void {
	if (mode === "idle") {
		ctx.ui.setStatus("spec-workflow", undefined);
		ctx.ui.setWidget("spec-workflow", undefined);
		return;
	}
	ctx.ui.setStatus("spec-workflow", mode);
	ctx.ui.setWidget("spec-workflow", [`Pi spec workflow: ${mode}`]);
}

export function enterMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: Mode): void {
	if (mode === "idle") return exitMode(pi, ctx);
	if (state.mode === mode) return;
	if (state.mode === "idle") {
		state.snapshot = pi.getActiveTools().map((tool) => tool.name);
	}
	state.mode = mode;
	const tools = mode === "spec-working" ? (state.snapshot ?? pi.getAllTools().map((tool) => tool.name)) : availableToolNames(pi, AUTHORING_TOOLS);
	pi.setActiveTools(tools);
	setWorkflowStatus(ctx, mode);
}

export function exitMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (state.snapshot) {
		pi.setActiveTools(state.snapshot);
	}
	state.mode = "idle";
	state.snapshot = undefined;
	setWorkflowStatus(ctx, "idle");
}

export function maybeBlockAuthoringToolCall(event: { toolName?: string; input?: unknown }) {
	if (state.mode !== "plan-authoring" && state.mode !== "spec-authoring") return;
	if (event.toolName === "write" || event.toolName === "edit") {
		return { block: true, reason: `${event.toolName} blocked during ${state.mode}; use workflow save tools.` };
	}
	if (event.toolName !== "bash") return;
	const input = event.input as { command?: unknown };
	if (typeof input.command !== "string") return;
	if (MUTATING_BASH.some((pattern) => pattern.test(input.command))) {
		return { block: true, reason: `Mutating shell command blocked during ${state.mode}.` };
	}
}
