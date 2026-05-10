import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./discovery.ts";
import { runSubagents } from "./engine.ts";
import { renderSubagentToolResult } from "./render.ts";
import { buildRunRequest, isAgentScope, normalizeSubagentRequest, type AgentScope } from "./request.ts";

export const SubagentToolParams = Type.Object({
	action: Type.Optional(Type.String()),
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(Type.Object({
		agent: Type.String(),
		task: Type.String(),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
		count: Type.Optional(Type.Number()),
	}))),
	chain: Type.Optional(Type.Array(Type.Object({
		agent: Type.Optional(Type.String()),
		task: Type.Optional(Type.String()),
		parallel: Type.Optional(Type.Array(Type.Object({
			agent: Type.String(),
			task: Type.String(),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(Type.String()),
			count: Type.Optional(Type.Number()),
		}))),
	}))),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	context: Type.Optional(Type.String()),
	agentScope: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
});

export function registerSubagentTool(pi: ExtensionAPI): void {
	assertNoSubagentToolOwner(pi);
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate tasks to local in-process subagents. Supports list/get, single agent, parallel tasks, and chain.",
		parameters: SubagentToolParams,
		renderResult: renderSubagentToolResult,
		async execute(_toolCallId, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			const cwd = typeof params.cwd === "string" ? params.cwd : ctx.cwd;
			const scope: AgentScope = isAgentScope(params.agentScope) ? params.agentScope : "both";
			const agents = discoverAgents({
				cwd,
				agentScope: scope,
				localPackagesDir: fileURLToPath(new URL("../..", import.meta.url)),
			});
			if (params.action === "list" || (!params.action && !params.agent && !params.tasks && !params.chain)) {
				return { content: [{ type: "text", text: formatAgentList(agents) }] };
			}
			if (params.action === "get" && typeof params.agent === "string") {
				return { content: [{ type: "text", text: formatAgentDetails(agents, params.agent) }] };
			}
			const normalization = normalizeSubagentRequest(params, {
				defaultLabel: Array.isArray(params.tasks) || Array.isArray(params.chain)
					? "subagents"
					: `subagent ${String(params.agent ?? "")}`.trim(),
			});
			if (!normalization.ok) {
				return { content: [{ type: "text", text: normalization.error }], isError: true };
			}
			const request = buildRunRequest(normalization.request, { cwd, parentSignal: signal });
			const result = await runSubagents(request, { agents });
			return {
				content: [{ type: "text", text: result.finalText || result.error || "No subagent output." }],
				details: { result },
				isError: result.status === "failed" || result.status === "cancelled",
			};
		},
	});
}

export function assertNoSubagentToolOwner(pi: ExtensionAPI): void {
	const owner = pi.getAllTools().find((tool) => tool.name === "subagent");
	if (owner) {
		throw new Error(`Cannot register local subagent tool: tool name "subagent" is already registered${owner.description ? ` (${owner.description})` : ""}.`);
	}
}

export function shouldRegisterLocalSubagentTool(pi: ExtensionAPI): boolean {
	return !pi.getAllTools().some((tool) => tool.name === "subagent");
}

function formatAgentList(agents: ReturnType<typeof discoverAgents>): string {
	if (agents.length === 0) return "No agents found.";
	return agents.map((agent) => `${agent.runtimeName} [${agent.source}]${agent.model ? ` · ${agent.model}` : ""}: ${agent.description ?? ""}`.trim()).join("\n");
}

function formatAgentDetails(agents: ReturnType<typeof discoverAgents>, name: string): string {
	const agent = agents.find((entry) => entry.runtimeName === name || entry.name === name);
	if (!agent) return `Unknown agent: ${name}`;
	return [
		`## ${agent.runtimeName} [${agent.source}]`,
		agent.description ? `Description: ${agent.description}` : undefined,
		agent.filePath ? `File: ${agent.filePath}` : undefined,
		agent.model ? `Model: ${agent.model}` : undefined,
		agent.thinking ? `Thinking: ${agent.thinking}` : undefined,
		agent.tools ? `Tools: ${Array.isArray(agent.tools) ? agent.tools.join(", ") : agent.tools}` : undefined,
		"",
		agent.systemPrompt,
	].filter((line) => line !== undefined).join("\n");
}
