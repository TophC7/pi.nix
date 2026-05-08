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

const SWORM_TOOLS = [
	"sworm_bridge_info",
	"sworm_epic_create",
	"sworm_epic_list",
	"sworm_epic_show",
	"sworm_epic_update",
	"sworm_epic_delete",
	"sworm_issue_list",
	"sworm_issue_ready",
	"sworm_issue_search",
	"sworm_issue_show",
	"sworm_issue_create",
	"sworm_issue_update",
	"sworm_issue_delete",
	"sworm_issue_claim",
	"sworm_comment_add",
	"sworm_comment_list",
	"sworm_comment_update",
	"sworm_comment_delete",
	"sworm_dependency_add",
	"sworm_dependency_remove",
	"sworm_dependency_list",
	"sworm_config_list",
	"sworm_config_get",
	"sworm_config_set",
];

const PLAN_AUTHORING_TOOLS = [
	...INSPECTION_TOOLS,
	"save_plan_draft",
];

const SPEC_AUTHORING_TOOLS = [
	...INSPECTION_TOOLS,
	"save_plan_draft",
	"save_spec",
	...SWORM_TOOLS,
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
	const authoringTools = mode === "plan-authoring" ? PLAN_AUTHORING_TOOLS : SPEC_AUTHORING_TOOLS;
	const tools = mode === "spec-working" ? (state.snapshot ?? pi.getAllTools().map((tool) => tool.name)) : availableToolNames(pi, authoringTools);
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
