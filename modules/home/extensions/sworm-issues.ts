import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import net from "node:net";

const REQUEST_TIMEOUT_MS = 8000;
let currentAgentId = process.env.SWORM_PI_MODEL ?? "pi";

export type BridgeError = { code: string; message: string };
type BridgeResponse<T = unknown> =
	| { id?: string; ok: true; result: T }
	| { id?: string; ok: false; error: BridgeError };

export type BridgeEnv = {
	projectId: string;
	socketPath: string;
	token: string;
	protocolVersion: string;
};

export type IssueSummary = {
	id: string;
	epicId?: string | null;
	parentIssueId?: string | null;
	title: string;
	status: string;
	priority: number;
	assigneeKind?: string;
	assigneeId?: string | null;
	tags?: string[];
};

type EpicSummary = {
	id: string;
	title: string;
	status: string;
	priority: number;
};

type CommentSummary = {
	id: string;
	issueId: string;
	author: string;
	body: string;
	createdAt?: string;
};

type DependencySummary = {
	id: string;
	issueId: string;
	dependsOnIssueId: string;
};

type ConfigEntry = {
	key: string;
	value: string;
};

export class SwormBridgeError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SwormBridgeError";
		this.code = code;
	}
}

export function readBridgeEnv(): BridgeEnv | null {
	const projectId = process.env.SWORM_PROJECT_ID;
	const socketPath = process.env.SWORM_ISSUES_SOCKET;
	const token = process.env.SWORM_ISSUES_TOKEN;
	const protocolVersion = process.env.SWORM_ISSUES_PROTOCOL_VERSION ?? "1";
	if (!projectId || !socketPath || !token) return null;
	return { projectId, socketPath, token, protocolVersion };
}

export function swormAgentId(): string {
	return currentAgentId;
}

export function swormUnavailableText(): string {
	return "Sworm issue bridge unavailable. Open this project in Sworm and launch Pi from Sworm.";
}

export function callBridge<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	const env = readBridgeEnv();
	if (!env) return Promise.reject(new SwormBridgeError("unavailable", swormUnavailableText()));

	return new Promise((resolve, reject) => {
		const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const socket = net.createConnection(env.socketPath);
		let buffer = "";
		let settled = false;

		const timeout = setTimeout(() => {
			finish(() => reject(new SwormBridgeError("timeout", `Sworm issue bridge timed out after ${REQUEST_TIMEOUT_MS}ms`)));
		}, REQUEST_TIMEOUT_MS);

		function finish(fn: () => void) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			fn();
		}

		socket.on("connect", () => {
			const payload = JSON.stringify({ id, token: env.token, method, params });
			socket.write(`${payload}\n`);
		});

		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			try {
				const response = JSON.parse(line) as BridgeResponse<T>;
				if (response.ok) finish(() => resolve(response.result));
				else finish(() => reject(new SwormBridgeError(response.error.code, response.error.message)));
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});

		socket.on("error", (error) => {
			finish(() => reject(new SwormBridgeError("connection_error", `${swormUnavailableText()} (${error.message})`)));
		});
	});
}

async function toolResult(method: string, params: Record<string, unknown> = {}) {
	try {
		const result = await callBridge(method, params);
		return {
			content: [{ type: "text" as const, text: formatSwormResult(result) }],
			details: { result },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = error instanceof SwormBridgeError ? error.code : "error";
		return {
			content: [{ type: "text" as const, text: `${code}: ${message}` }],
			details: { error: { code, message } },
			isError: true,
		};
	}
}

export function formatSwormResult(result: unknown): string {
	if (Array.isArray(result)) {
		if (result.length === 0) return "No Sworm records.";
		return result.map(formatSwormRecord).join("\n");
	}
	if (isIssueDetail(result)) return formatIssueDetail(result);
	if (isRecord(result)) return formatSwormRecord(result);
	return JSON.stringify(result, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isIssue(value: unknown): value is IssueSummary {
	return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.status === "string" && typeof value.priority === "number";
}

function isEpic(value: unknown): value is EpicSummary {
	return isRecord(value) && typeof value.id === "string" && String(value.id).startsWith("EPIC-") && typeof value.title === "string";
}

function isComment(value: unknown): value is CommentSummary {
	return isRecord(value) && typeof value.id === "string" && typeof value.issueId === "string" && typeof value.body === "string";
}

function isDependency(value: unknown): value is DependencySummary {
	return isRecord(value) && typeof value.issueId === "string" && typeof value.dependsOnIssueId === "string";
}

function isConfig(value: unknown): value is ConfigEntry {
	return isRecord(value) && typeof value.key === "string" && typeof value.value === "string";
}

function isIssueDetail(value: unknown): value is { issue: IssueSummary; comments?: CommentSummary[]; dependsOn?: DependencySummary[]; blockedBy?: DependencySummary[]; subIssues?: IssueSummary[] } {
	return isRecord(value) && isIssue(value.issue);
}

function formatSwormRecord(value: unknown): string {
	if (isEpic(value)) return `${value.id} | P${value.priority} | ${value.status} | ${value.title}`;
	if (isIssue(value)) return formatIssueLine(value);
	if (isComment(value)) return `${value.id} | ${value.issueId} | ${value.author} | ${firstLine(value.body)}`;
	if (isDependency(value)) return `${value.issueId} depends on ${value.dependsOnIssueId}`;
	if (isConfig(value)) return `${value.key}=${value.value}`;
	return JSON.stringify(value, null, 2);
}

function formatIssueLine(value: IssueSummary): string {
	const epic = value.epicId ? ` ${value.epicId}` : "";
	const assignee = value.assigneeId ? ` @${value.assigneeId}` : "";
	const tags = value.tags?.length ? ` [${value.tags.join(",")}]` : "";
	return `${value.id}${epic} | P${value.priority} | ${value.status}${assignee}${tags} | ${value.title}`;
}

function formatIssueDetail(detail: { issue: IssueSummary; comments?: CommentSummary[]; dependsOn?: DependencySummary[]; blockedBy?: DependencySummary[]; subIssues?: IssueSummary[] }): string {
	const lines = [formatIssueLine(detail.issue)];
	if (detail.dependsOn?.length) lines.push(`depends on: ${detail.dependsOn.map((dep) => dep.dependsOnIssueId).join(", ")}`);
	if (detail.blockedBy?.length) lines.push(`blocks: ${detail.blockedBy.map((dep) => dep.issueId).join(", ")}`);
	if (detail.subIssues?.length) lines.push(`sub-issues:\n${detail.subIssues.map(formatIssueLine).join("\n")}`);
	if (detail.comments?.length) lines.push(`comments:\n${detail.comments.map((comment) => `- ${comment.id} ${comment.author}: ${firstLine(comment.body)}`).join("\n")}`);
	return lines.join("\n");
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() || "";
}

async function bestEffortCall<T>(method: string, params: Record<string, unknown> = {}, fallback: T): Promise<T> {
	try {
		return await callBridge<T>(method, params);
	} catch {
		return fallback;
	}
}

const IssueStatus = Type.Union([
	Type.Literal("todo"),
	Type.Literal("in_progress"),
	Type.Literal("blocked"),
	Type.Literal("completed"),
	Type.Literal("wont_fix"),
	Type.Literal("archived"),
]);

const EpicStatus = Type.Union([
	Type.Literal("todo"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("archived"),
]);

const AssigneeKind = Type.Union([
	Type.Literal("human"),
	Type.Literal("agent"),
	Type.Literal("session"),
	Type.Literal("unassigned"),
]);

const Priority = Type.Optional(Type.Number({ minimum: 0, maximum: 5 }));
const MaybeString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const Limit = Type.Optional(Type.Number({ minimum: 1, maximum: 500 }));

function withActor<T extends Record<string, unknown>>(value: T): T & { actor: string } {
	return { ...value, actor: swormAgentId() };
}

export default function swormIssuesExtension(pi: ExtensionAPI) {
	pi.on("model_select", async (event) => {
		currentAgentId = `${event.model.provider}/${event.model.id}`;
	});

	pi.registerTool({
		name: "sworm_bridge_info",
		label: "Sworm Bridge Info",
		description: "Show Sworm issue bridge project, protocol, capabilities, and methods.",
		parameters: Type.Object({}),
		execute: async () => toolResult("bridge.info"),
	});

	pi.registerTool({
		name: "sworm_epic_create",
		label: "Sworm Epic Create",
		description: "Create a Sworm epic.",
		promptSnippet: "Create Sworm epic",
		parameters: Type.Object({ title: Type.String(), description: MaybeString, status: Type.Optional(EpicStatus), priority: Priority }),
		execute: async (_id, params) => toolResult("epic.create", withActor(params)),
	});

	pi.registerTool({
		name: "sworm_epic_list",
		label: "Sworm Epic List",
		description: "List Sworm epics.",
		parameters: Type.Object({}),
		execute: async () => toolResult("epic.list"),
	});

	pi.registerTool({
		name: "sworm_epic_show",
		label: "Sworm Epic Show",
		description: "Show one Sworm epic.",
		parameters: Type.Object({ epicId: Type.String() }),
		execute: async (_id, params) => toolResult("epic.show", params),
	});

	pi.registerTool({
		name: "sworm_epic_update",
		label: "Sworm Epic Update",
		description: "Update a Sworm epic.",
		parameters: Type.Object({ epicId: Type.String(), title: Type.Optional(Type.String()), description: MaybeString, status: Type.Optional(EpicStatus), priority: Priority }),
		execute: async (_id, params) => {
			const { epicId, ...patch } = params;
			return toolResult("epic.update", { epicId, patch: withActor(patch) });
		},
	});

	pi.registerTool({
		name: "sworm_epic_delete",
		label: "Sworm Epic Delete",
		description: "Delete an empty Sworm epic. Fails if issues still reference it.",
		parameters: Type.Object({ epicId: Type.String() }),
		execute: async (_id, params) => toolResult("epic.delete", params),
	});

	pi.registerTool({
		name: "sworm_issue_list",
		label: "Sworm Issue List",
		description: "List Sworm issues with optional filters.",
		parameters: Type.Object({ status: Type.Optional(IssueStatus), epicId: Type.Optional(Type.String()), includeArchived: Type.Optional(Type.Boolean()), limit: Limit }),
		execute: async (_id, params) => toolResult("issue.list", { filters: params }),
	});

	pi.registerTool({
		name: "sworm_issue_ready",
		label: "Sworm Ready Issues",
		description: "List Sworm top-level todo issues with no unresolved dependencies.",
		promptSnippet: "List ready Sworm issues",
		promptGuidelines: ["Use sworm_issue_ready before choosing durable project work when Sworm issue memory is available."],
		parameters: Type.Object({ epicId: Type.Optional(Type.String()), limit: Limit }),
		execute: async (_id, params) => toolResult("issue.ready", { filters: params }),
	});

	pi.registerTool({
		name: "sworm_issue_search",
		label: "Sworm Issue Search",
		description: "Search Sworm issue titles, descriptions, comments, and epic titles.",
		promptSnippet: "Search Sworm issues",
		promptGuidelines: ["Use sworm_issue_search to recover prior decisions, blockers, notes, and tasks."],
		parameters: Type.Object({ query: Type.String(), status: Type.Optional(IssueStatus), epicId: Type.Optional(Type.String()), includeArchived: Type.Optional(Type.Boolean()), limit: Limit }),
		execute: async (_id, params) => {
			const { query, ...filters } = params;
			return toolResult("issue.search", { query, filters });
		},
	});

	pi.registerTool({
		name: "sworm_issue_show",
		label: "Sworm Issue Show",
		description: "Show full Sworm issue detail, comments, dependencies, sub-issues, and events.",
		promptSnippet: "Show Sworm issue detail",
		parameters: Type.Object({ issueId: Type.String() }),
		execute: async (_id, params) => toolResult("issue.show", params),
	});

	pi.registerTool({
		name: "sworm_issue_create",
		label: "Sworm Issue Create",
		description: "Create a Sworm issue. Root issues require epicId; sub-issues require parentIssueId.",
		promptSnippet: "Create Sworm issue",
		promptGuidelines: ["Create durable tasks, blockers, follow-ups, or discoveries that should survive this agent session."],
		parameters: Type.Object({
			title: Type.String(),
			description: MaybeString,
			status: Type.Optional(IssueStatus),
			priority: Priority,
			epicId: MaybeString,
			parentIssueId: MaybeString,
			assigneeKind: Type.Optional(AssigneeKind),
			assigneeId: MaybeString,
			tags: Type.Optional(Type.Array(Type.String())),
			contextJson: MaybeString,
		}),
		execute: async (_id, params) => toolResult("issue.create", withActor(params)),
	});

	pi.registerTool({
		name: "sworm_issue_update",
		label: "Sworm Issue Update",
		description: "Update status, title, description, priority, epic, assignee, tags, or context for a Sworm issue.",
		promptSnippet: "Update Sworm issue",
		parameters: Type.Object({
			issueId: Type.String(),
			title: Type.Optional(Type.String()),
			description: MaybeString,
			status: Type.Optional(IssueStatus),
			priority: Priority,
			epicId: MaybeString,
			assigneeKind: Type.Optional(AssigneeKind),
			assigneeId: MaybeString,
			tags: Type.Optional(Type.Array(Type.String())),
			contextJson: MaybeString,
		}),
		execute: async (_id, params) => {
			const { issueId, ...patch } = params;
			return toolResult("issue.update", { issueId, patch: withActor(patch) });
		},
	});

	pi.registerTool({
		name: "sworm_issue_delete",
		label: "Sworm Issue Delete",
		description: "Hard-delete a Sworm issue and cascading comments/dependency rows.",
		parameters: Type.Object({ issueId: Type.String() }),
		execute: async (_id, params) => toolResult("issue.delete", params),
	});

	pi.registerTool({
		name: "sworm_issue_claim",
		label: "Sworm Issue Claim",
		description: "Claim a Sworm issue and mark it in progress for the current agent.",
		promptSnippet: "Claim Sworm issue",
		parameters: Type.Object({ issueId: Type.String(), assigneeKind: Type.Optional(AssigneeKind), assigneeId: Type.Optional(Type.String()) }),
		execute: async (_id, params) => toolResult("issue.claim", { issueId: params.issueId, assigneeKind: params.assigneeKind ?? "agent", assigneeId: params.assigneeId ?? swormAgentId(), actor: swormAgentId() }),
	});

	pi.registerTool({
		name: "sworm_comment_add",
		label: "Sworm Comment Add",
		description: "Add a Sworm comment/note to an issue.",
		promptSnippet: "Add Sworm issue note",
		promptGuidelines: ["Use comments for durable findings, blockers, evidence, manual checks, and completion summaries."],
		parameters: Type.Object({ issueId: Type.String(), body: Type.String(), author: Type.Optional(Type.String()) }),
		execute: async (_id, params) => toolResult("comment.add", { issueId: params.issueId, body: params.body, author: params.author ?? swormAgentId(), actor: swormAgentId() }),
	});

	pi.registerTool({
		name: "sworm_comment_list",
		label: "Sworm Comment List",
		description: "List comments on a Sworm issue.",
		parameters: Type.Object({ issueId: Type.String() }),
		execute: async (_id, params) => toolResult("comment.list", params),
	});

	pi.registerTool({
		name: "sworm_comment_update",
		label: "Sworm Comment Update",
		description: "Update a Sworm comment body.",
		parameters: Type.Object({ commentId: Type.String(), body: Type.String() }),
		execute: async (_id, params) => toolResult("comment.update", { commentId: params.commentId, input: { body: params.body, actor: swormAgentId() } }),
	});

	pi.registerTool({
		name: "sworm_comment_delete",
		label: "Sworm Comment Delete",
		description: "Delete a Sworm comment.",
		parameters: Type.Object({ commentId: Type.String() }),
		execute: async (_id, params) => toolResult("comment.delete", params),
	});

	pi.registerTool({
		name: "sworm_dependency_add",
		label: "Sworm Dependency Add",
		description: "Mark one Sworm issue as depending on another.",
		parameters: Type.Object({ issueId: Type.String(), dependsOnIssueId: Type.String() }),
		execute: async (_id, params) => toolResult("dependency.add", withActor(params)),
	});

	pi.registerTool({
		name: "sworm_dependency_remove",
		label: "Sworm Dependency Remove",
		description: "Remove a Sworm issue dependency edge.",
		parameters: Type.Object({ issueId: Type.String(), dependsOnIssueId: Type.String() }),
		execute: async (_id, params) => toolResult("dependency.remove", withActor(params)),
	});

	pi.registerTool({
		name: "sworm_dependency_list",
		label: "Sworm Dependency List",
		description: "List outgoing dependencies for a Sworm issue.",
		parameters: Type.Object({ issueId: Type.String() }),
		execute: async (_id, params) => toolResult("dependency.list", params),
	});

	pi.registerTool({
		name: "sworm_config_list",
		label: "Sworm Config List",
		description: "List Sworm issue prefix config entries.",
		parameters: Type.Object({}),
		execute: async () => toolResult("config.list"),
	});

	pi.registerTool({
		name: "sworm_config_get",
		label: "Sworm Config Get",
		description: "Get one Sworm issue config entry.",
		parameters: Type.Object({ key: Type.String() }),
		execute: async (_id, params) => toolResult("config.get", params),
	});

	pi.registerTool({
		name: "sworm_config_set",
		label: "Sworm Config Set",
		description: "Set one Sworm issue prefix config entry.",
		parameters: Type.Object({ key: Type.String(), value: Type.String() }),
		execute: async (_id, params) => toolResult("config.set", params),
	});

	pi.registerCommand("ready", {
		description: "Show Sworm ready issues",
		handler: async (args, ctx) => {
			const limit = Number(args.trim()) || 10;
			try {
				const ready = await callBridge<IssueSummary[]>("issue.ready", { filters: { limit } });
				ctx.ui.notify(ready.length ? ready.map(formatIssueLine).join("\n") : "No ready Sworm issues.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerCommand("issues", {
		description: "Show Sworm issue bridge status",
		handler: async (_args, ctx) => {
			try {
				const [info, epics, ready, config] = await Promise.all([
					callBridge("bridge.info"),
					callBridge<EpicSummary[]>("epic.list"),
					callBridge<IssueSummary[]>("issue.ready", { filters: { limit: 10 } }),
					callBridge<ConfigEntry[]>("config.list"),
				]);
				ctx.ui.notify([
					`Sworm issues connected: ${readBridgeEnv()?.projectId ?? "unknown"}`,
					`Bridge: ${JSON.stringify(info)}`,
					`Prefixes: ${config.map((entry) => `${entry.key}=${entry.value}`).join(", ")}`,
					`Epics: ${epics.length}`,
					`Ready: ${ready.length ? ready.map(formatIssueLine).join("\n") : "none"}`,
				].join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerCommand("claim", {
		description: "Claim a Sworm issue: /claim ISSUE-1",
		handler: async (args, ctx) => {
			const issueId = args.trim();
			if (!issueId) {
				ctx.ui.notify("Usage: /claim <issue-id>", "warning");
				return;
			}
			try {
				const issue = await callBridge("issue.claim", { issueId, assigneeKind: "agent", assigneeId: swormAgentId(), actor: swormAgentId() });
				ctx.ui.notify(formatSwormResult(issue), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		const env = readBridgeEnv();
		if (!env) return undefined;
		const [epics, ready, inProgress] = await Promise.all([
			bestEffortCall<EpicSummary[]>("epic.list", {}, []),
			bestEffortCall<IssueSummary[]>("issue.ready", { filters: { limit: 5 } }, []),
			bestEffortCall<IssueSummary[]>("issue.list", { filters: { status: "in_progress", limit: 20 } }, []),
		]);
		const mine = inProgress.filter((issue) => issue.assigneeId === swormAgentId());
		const readyText = ready.length ? ready.map(formatIssueLine).join("\n") : "No ready Sworm issues.";
		const activeText = mine.length ? mine.map(formatIssueLine).join("\n") : "No active Sworm issues assigned to this agent.";
		const epicText = epics.length ? epics.slice(0, 10).map((epic) => `${epic.id} | ${epic.status} | ${epic.title}`).join("\n") : "No Sworm epics.";
		return {
			systemPrompt:
				event.systemPrompt +
				`

Sworm issue memory is available for project ${env.projectId}.
Use sworm_* tools for durable epics, issues, comments, dependencies, config, blockers, and completion summaries.
ID prefixes: EPIC / ISSUE / NOTE.
Active Sworm issues assigned to current agent:
${activeText}
Top ready Sworm issues:
${readyText}
Sworm epics:
${epicText}
`,
		};
	});
}
