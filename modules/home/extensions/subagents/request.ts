import { randomUUID } from "node:crypto";
import type { SubagentRunMode, SubagentRunRequest, SubagentSlotPlan } from "./types.ts";

export const SUBAGENT_MAX_PARALLEL_SLOTS = 32;
export const SUBAGENT_MAX_TASK_COUNT = 16;
export const SUBAGENT_MAX_CHAIN_STEPS = 16;

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

export const SUBAGENT_SYSTEM_PROMPT_MODES = ["replace", "append"] as const;
export type SubagentSystemPromptMode = (typeof SUBAGENT_SYSTEM_PROMPT_MODES)[number];

export type AgentScope = "user" | "project" | "both";

export interface NormalizedTask {
	agent: string;
	task: string;
	model?: string;
	thinking?: SubagentThinkingLevel;
	count: number;
}

export interface NormalizedChainStep {
	groupId: string;
	parallel: NormalizedTask[];
}

export interface NormalizedRequest {
	mode: SubagentRunMode;
	label: string;
	context?: "fresh" | "fork";
	agentScope: AgentScope;
	cwd?: string;
	tasks: NormalizedTask[];
	chain: NormalizedChainStep[];
}

export type RequestNormalization =
	| { ok: true; request: NormalizedRequest }
	| { ok: false; error: string };

export interface RequestNormalizationOptions {
	defaultLabel?: string;
}

export function normalizeSubagentRequest(input: unknown, options: RequestNormalizationOptions = {}): RequestNormalization {
	if (!input || typeof input !== "object") return { ok: false, error: "Subagent request must be an object." };
	const params = input as Record<string, unknown>;
	const label = options.defaultLabel ?? "subagents";
	const cwd = stringOrUndefined(params.cwd);
	const context = parseContext(params.context);
	const agentScope = parseAgentScope(params.agentScope);

	if (Array.isArray(params.chain)) {
		const chainResult = parseChain(params.chain);
		if (!chainResult.ok) return chainResult;
		return {
			ok: true,
			request: {
				mode: "chain",
				label,
				context,
				agentScope,
				cwd,
				tasks: [],
				chain: chainResult.steps,
			},
		};
	}

	if (Array.isArray(params.tasks)) {
		const tasksResult = parseTasks(params.tasks);
		if (!tasksResult.ok) return tasksResult;
		const totalSlots = tasksResult.tasks.reduce((sum, task) => sum + task.count, 0);
		if (totalSlots === 0) return { ok: false, error: "Subagent request 'tasks' produced no runnable slots." };
		if (totalSlots > SUBAGENT_MAX_PARALLEL_SLOTS) {
			return { ok: false, error: `Subagent parallel slots ${totalSlots} exceed cap ${SUBAGENT_MAX_PARALLEL_SLOTS}. Reduce 'count' or split.` };
		}
		return {
			ok: true,
			request: {
				mode: "parallel",
				label,
				context,
				agentScope,
				cwd,
				tasks: tasksResult.tasks,
				chain: [],
			},
		};
	}

	if (typeof params.agent === "string" && typeof params.task === "string") {
		return {
			ok: true,
			request: {
				mode: "single",
				label,
				context,
				agentScope,
				cwd,
				tasks: [{
					agent: params.agent,
					task: params.task,
					model: stringOrUndefined(params.model),
					thinking: parseThinking(params.thinking),
					count: 1,
				}],
				chain: [],
			},
		};
	}

	return { ok: false, error: "Subagent request requires { agent, task }, { tasks: [...] }, or { chain: [...] }." };
}

export function buildRunRequest(
	normalized: NormalizedRequest,
	overrides: { id?: string; cwd: string; createdAt?: number; parentSignal?: AbortSignal; depth?: number; maxDepth?: number },
): SubagentRunRequest {
	return {
		id: overrides.id ?? randomUUID(),
		mode: normalized.mode,
		label: normalized.label,
		slots: buildSlots(normalized),
		cwd: normalized.cwd ?? overrides.cwd,
		createdAt: overrides.createdAt ?? Date.now(),
		context: normalized.context,
		depth: overrides.depth ?? 0,
		maxDepth: overrides.maxDepth ?? 0,
		parentSignal: overrides.parentSignal,
	};
}

export function isAgentScope(value: unknown): value is AgentScope {
	return value === "user" || value === "project" || value === "both";
}

function buildSlots(normalized: NormalizedRequest): SubagentSlotPlan[] {
	if (normalized.mode === "chain") return buildChainSlots(normalized.chain);
	const slots: SubagentSlotPlan[] = [];
	normalized.tasks.forEach((task, taskIndex) => {
		for (let repeat = 0; repeat < task.count; repeat++) {
			slots.push({
				id: `${normalized.mode}-${taskIndex}-${repeat}-${randomUUID()}`,
				agent: task.agent,
				task: task.task,
				model: task.model,
				thinking: task.thinking,
				groupId: normalized.mode === "parallel" ? "parallel" : undefined,
				groupIndex: normalized.mode === "parallel" ? taskIndex : undefined,
			});
		}
	});
	return slots;
}

function buildChainSlots(chain: NormalizedChainStep[]): SubagentSlotPlan[] {
	const slots: SubagentSlotPlan[] = [];
	let previousIds: string[] = [];
	chain.forEach((step, stepIndex) => {
		const stepSlots: SubagentSlotPlan[] = [];
		step.parallel.forEach((task, taskIndex) => {
			for (let repeat = 0; repeat < task.count; repeat++) {
				stepSlots.push({
					id: `${step.groupId}-${taskIndex}-${repeat}-${randomUUID()}`,
					agent: task.agent,
					task: task.task,
					model: task.model,
					thinking: task.thinking,
					groupId: step.groupId,
					groupIndex: stepIndex,
					dependsOnSlotIds: previousIds,
				});
			}
		});
		slots.push(...stepSlots);
		previousIds = stepSlots.map((slot) => slot.id);
	});
	return slots;
}

function parseTasks(rawTasks: unknown[]): { ok: true; tasks: NormalizedTask[] } | { ok: false; error: string } {
	const tasks: NormalizedTask[] = [];
	for (let index = 0; index < rawTasks.length; index++) {
		const parsed = parseTaskEntry(rawTasks[index], `tasks[${index}]`);
		if (!parsed.ok) return parsed;
		tasks.push(parsed.task);
	}
	return { ok: true, tasks };
}

function parseChain(rawChain: unknown[]): { ok: true; steps: NormalizedChainStep[] } | { ok: false; error: string } {
	if (rawChain.length === 0) return { ok: false, error: "Subagent 'chain' requires at least one step." };
	if (rawChain.length > SUBAGENT_MAX_CHAIN_STEPS) {
		return { ok: false, error: `Subagent chain exceeds cap ${SUBAGENT_MAX_CHAIN_STEPS}.` };
	}
	const steps: NormalizedChainStep[] = [];
	for (let index = 0; index < rawChain.length; index++) {
		const step = rawChain[index];
		if (!step || typeof step !== "object") return { ok: false, error: `chain[${index}] must be an object.` };
		const data = step as { agent?: unknown; task?: unknown; parallel?: unknown };
		const groupId = `chain-${index}`;
		if (Array.isArray(data.parallel)) {
			const parallel = parseTasks(data.parallel);
			if (!parallel.ok) return parallel;
			steps.push({ groupId, parallel: parallel.tasks });
			continue;
		}
		if (typeof data.agent === "string" && typeof data.task === "string") {
			steps.push({
				groupId,
				parallel: [{ agent: data.agent, task: data.task, count: 1 }],
			});
			continue;
		}
		return { ok: false, error: `chain[${index}] needs 'agent'+'task' or a 'parallel' array.` };
	}
	return { ok: true, steps };
}

function parseTaskEntry(value: unknown, location: string): { ok: true; task: NormalizedTask } | { ok: false; error: string } {
	if (!value || typeof value !== "object") return { ok: false, error: `${location} must be an object.` };
	const data = value as { agent?: unknown; task?: unknown; model?: unknown; thinking?: unknown; count?: unknown };
	if (typeof data.agent !== "string" || !data.agent.trim()) return { ok: false, error: `${location} requires non-empty 'agent'.` };
	if (typeof data.task !== "string" || !data.task.trim()) return { ok: false, error: `${location} requires non-empty 'task'.` };
	const count = parseCount(data.count, location);
	if (!count.ok) return count;
	return {
		ok: true,
		task: {
			agent: data.agent,
			task: data.task,
			model: stringOrUndefined(data.model),
			thinking: parseThinking(data.thinking),
			count: count.value,
		},
	};
}

function parseCount(value: unknown, location: string): { ok: true; value: number } | { ok: false; error: string } {
	if (value === undefined || value === null) return { ok: true, value: 1 };
	if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `${location}.count must be a finite number.` };
	const integer = Math.floor(value);
	if (integer < 1) return { ok: false, error: `${location}.count must be ≥ 1.` };
	if (integer > SUBAGENT_MAX_TASK_COUNT) {
		return { ok: false, error: `${location}.count ${integer} exceeds cap ${SUBAGENT_MAX_TASK_COUNT}.` };
	}
	return { ok: true, value: integer };
}

function parseContext(value: unknown): "fresh" | "fork" | undefined {
	return value === "fresh" || value === "fork" ? value : undefined;
}

function parseAgentScope(value: unknown): AgentScope {
	return isAgentScope(value) ? value : "both";
}

export function parseThinking(value: unknown): SubagentThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	return (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(value) ? value as SubagentThinkingLevel : undefined;
}

export function parseSystemPromptMode(value: unknown): SubagentSystemPromptMode | undefined {
	if (typeof value !== "string") return undefined;
	return (SUBAGENT_SYSTEM_PROMPT_MODES as readonly string[]).includes(value) ? value as SubagentSystemPromptMode : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
