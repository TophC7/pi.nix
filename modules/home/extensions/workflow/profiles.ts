import type { WorkflowBashRule, WorkflowId, WorkflowProfile, WorkflowSafetyPolicy } from "./types.ts";

export const INSPECTION_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"ask_user",
	"AskClaude",
	"subagent",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
] as const;

export const FILE_MUTATION_TOOLS = ["edit", "write"] as const;

export const IMPLEMENTATION_CORE_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export const SWORM_TOOLS = [
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
] as const;

export const PLAN_WORKFLOW_TOOLS = ["save_plan_draft", "promote_plan"] as const;

export const SPEC_WORKFLOW_TOOLS = ["save_plan_draft", "save_spec"] as const;

export const SAFE_DEFAULT_TOOLS = ["read", "grep", "find", "ls", "ask_user"] as const;

export const AUTHORING_BASH_RULES: readonly WorkflowBashRule[] = [
	{ id: "rm", pattern: /\brm\b/, reason: "removes files" },
	{ id: "mv", pattern: /\bmv\b/, reason: "moves or renames files" },
	{ id: "cp", pattern: /\bcp\b/, reason: "writes files" },
	{ id: "mkdir", pattern: /\bmkdir\b/, reason: "creates directories" },
	{ id: "touch", pattern: /\btouch\b/, reason: "creates or mutates files" },
	{ id: "git-mutator", pattern: /\bgit\s+(add|commit|push|reset|checkout|switch|merge|rebase|clean|stash|restore)\b/, reason: "mutates git state or working tree" },
	{ id: "redirect", pattern: />|>>|\d>/, reason: "writes command output to files" },
	{ id: "xargs", pattern: /\|\s*xargs\b/, reason: "can fan out mutation commands" },
	{ id: "package-mutator", pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/, reason: "mutates dependencies" },
] as const;

export const REVIEW_BASH_RULES: readonly WorkflowBashRule[] = [
	...AUTHORING_BASH_RULES,
	{ id: "sed-in-place", pattern: /\bsed\b[^\n]*(?:\s--in-place(?:[=\s]|$)|\s-i(?:\S*|\s|$))/, reason: "edits files in place" },
	{ id: "tee", pattern: /\btee\b/, reason: "writes stdin to files" },
	{ id: "chmod-chown", pattern: /\b(chmod|chown|truncate)\b/, reason: "mutates file metadata or contents" },
	{ id: "python-writes", pattern: /\bpython[\d.]*\s+-c\b[^\n]*(write|open\([^)]*,\s*[\"']w|Path\([^)]*\)\.write_)/, reason: "inline Python can write files" },
] as const;

const AUTHORING_SAFETY: WorkflowSafetyPolicy = {
	blocksFileMutationTools: true,
	allowsImplementationWrites: false,
	blocksMutatingShell: true,
	blockedBash: AUTHORING_BASH_RULES,
};

const REVIEW_AUTHORING_SAFETY: WorkflowSafetyPolicy = {
	...AUTHORING_SAFETY,
	blockedBash: REVIEW_BASH_RULES,
};

const IMPLEMENTATION_SAFETY: WorkflowSafetyPolicy = {
	blocksFileMutationTools: false,
	allowsImplementationWrites: true,
	blocksMutatingShell: false,
	blockedBash: [],
};

const HANDOFF_SAFETY: WorkflowSafetyPolicy = {
	blocksFileMutationTools: true,
	allowsImplementationWrites: false,
	blocksMutatingShell: true,
	blockedBash: AUTHORING_BASH_RULES,
};

function uniqueTools(...groups: readonly (readonly string[])[]): readonly string[] {
	return [...new Set(groups.flat())];
}

function profile(input: WorkflowProfile): WorkflowProfile {
	return input;
}

export const WORKFLOW_PROFILES = [
	profile({
		id: "plan-authoring",
		owner: "spec",
		phase: "authoring",
		label: "Plan authoring",
		statusKey: "spec-workflow",
		tools: {
			required: uniqueTools(INSPECTION_TOOLS, PLAN_WORKFLOW_TOOLS),
			optional: [],
			blocked: FILE_MUTATION_TOOLS,
		},
		safety: AUTHORING_SAFETY,
		restore: {
			normalExit: "previous-active-tools",
			failure: "restore-previous-or-safe-default",
			cancellation: "restore-previous-or-safe-default",
			safeDefaultTools: SAFE_DEFAULT_TOOLS,
		},
		persistence: {
			markerType: "pi-workflow-state",
			persistMarker: true,
			persistToolSnapshot: true,
			recoverOnSessionStart: true,
		},
	}),
	profile({
		id: "spec-authoring",
		owner: "spec",
		phase: "authoring",
		label: "Spec authoring",
		statusKey: "spec-workflow",
		tools: {
			required: uniqueTools(INSPECTION_TOOLS, SPEC_WORKFLOW_TOOLS, SWORM_TOOLS),
			optional: [],
			blocked: FILE_MUTATION_TOOLS,
		},
		safety: AUTHORING_SAFETY,
		restore: {
			normalExit: "previous-active-tools",
			failure: "restore-previous-or-safe-default",
			cancellation: "restore-previous-or-safe-default",
			safeDefaultTools: SAFE_DEFAULT_TOOLS,
		},
		persistence: {
			markerType: "pi-workflow-state",
			persistMarker: true,
			persistToolSnapshot: true,
			recoverOnSessionStart: true,
		},
	}),
	profile({
		id: "spec-working",
		owner: "spec",
		phase: "implementation",
		label: "Spec working",
		statusKey: "spec-workflow",
		tools: {
			required: uniqueTools(IMPLEMENTATION_CORE_TOOLS, FILE_MUTATION_TOOLS, SWORM_TOOLS),
			optional: ["ask_user", "AskClaude", "subagent", "web_search", "code_search", "fetch_content", "get_search_content"],
			blocked: [],
		},
		safety: IMPLEMENTATION_SAFETY,
		restore: {
			normalExit: "previous-active-tools",
			failure: "restore-previous-or-safe-default",
			cancellation: "restore-previous-or-safe-default",
			safeDefaultTools: SAFE_DEFAULT_TOOLS,
		},
		persistence: {
			markerType: "pi-workflow-state",
			persistMarker: true,
			persistToolSnapshot: true,
			recoverOnSessionStart: true,
		},
	}),
	profile({
		id: "plan-review-authoring",
		owner: "plan-review",
		phase: "authoring",
		label: "Plan review authoring",
		statusKey: "spec-workflow",
		tools: {
			required: uniqueTools(INSPECTION_TOOLS, PLAN_WORKFLOW_TOOLS),
			optional: [],
			blocked: FILE_MUTATION_TOOLS,
		},
		safety: REVIEW_AUTHORING_SAFETY,
		restore: {
			normalExit: "previous-active-tools",
			failure: "restore-previous-or-safe-default",
			cancellation: "restore-previous-or-safe-default",
			safeDefaultTools: SAFE_DEFAULT_TOOLS,
		},
		persistence: {
			markerType: "pi-workflow-state",
			persistMarker: true,
			persistToolSnapshot: true,
			recoverOnSessionStart: true,
		},
	}),
	profile({
		id: "cleanup",
		owner: "cleanup",
		phase: "implementation",
		label: "Cleanup",
		statusKey: "cleanup-workflow",
		tools: {
			required: ["bash", "read", "grep", "find", "ls", "subagent", "edit", "write"],
			optional: ["ask_user", "AskClaude"],
			blocked: [],
		},
		safety: IMPLEMENTATION_SAFETY,
		restore: {
			normalExit: "previous-active-tools",
			failure: "restore-previous-or-safe-default",
			cancellation: "restore-previous-or-safe-default",
			safeDefaultTools: SAFE_DEFAULT_TOOLS,
		},
		persistence: {
			markerType: "pi-workflow-state",
			persistMarker: true,
			persistToolSnapshot: true,
			recoverOnSessionStart: true,
		},
	}),
	// Handoff is a controller phase, not an LLM capability profile. It carries
	// restore/persistence/safety policy for local queue transfer work.
	profile({
		id: "handoff",
		owner: "workflow",
		phase: "handoff",
		label: "Workflow handoff",
		statusKey: "workflow-handoff",
		tools: {
			required: [],
			optional: [],
			blocked: FILE_MUTATION_TOOLS,
		},
		safety: HANDOFF_SAFETY,
		restore: {
			normalExit: "previous-active-tools",
			failure: "restore-previous-or-safe-default",
			cancellation: "restore-previous-or-safe-default",
			safeDefaultTools: SAFE_DEFAULT_TOOLS,
		},
		persistence: {
			markerType: "pi-workflow-state",
			persistMarker: true,
			persistToolSnapshot: true,
			recoverOnSessionStart: true,
		},
	}),
] as const satisfies readonly WorkflowProfile[];

export function getWorkflowProfile(id: WorkflowId): WorkflowProfile {
	const found = WORKFLOW_PROFILES.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`Unknown workflow profile: ${id}`);
	return found;
}

export function getProfileToolNames(profile: WorkflowProfile): readonly string[] {
	return uniqueTools(profile.tools.required, profile.tools.optional);
}
