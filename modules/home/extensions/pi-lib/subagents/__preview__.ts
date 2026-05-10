// ABOUT: Visual preview harness for the renderer. Builds synthetic
// SubagentRunState fixtures and prints rendered frames to stdout at two widths.
// Run with bun via:  bun modules/home/extensions/pi-lib/subagents/__preview__.ts
//
// NOTE: this file is dev-only; it's safe to keep in tree because pi only loads
// extensions whose names don't start with `__`. Pi will skip it.

import type { Theme } from "@mariozechner/pi-coding-agent";
import { renderSubagentRun } from "./render.ts";
import {
	combineSubagentUsage,
	emptySubagentUsage,
	type SubagentRunResult,
	type SubagentRunState,
	type SubagentSlotResult,
	type SubagentToolSnapshot,
} from "./types.ts";

const ANSI = {
	dim: "\x1b[2m",
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};

const fakeTheme: Theme = {
	fg(name: string, text: string) {
		const map: Record<string, string> = {
			accent: ANSI.cyan,
			success: ANSI.green,
			error: ANSI.red,
			warning: ANSI.yellow,
			dim: ANSI.dim,
			muted: ANSI.gray,
			toolTitle: ANSI.bold + ANSI.magenta,
		};
		const code = map[name] ?? "";
		return code ? `${code}${text}${ANSI.reset}` : text;
	},
	bg(_name: string, text: string) { return text; },
	bold(text: string) { return `${ANSI.bold}${text}${ANSI.reset}`; },
} as unknown as Theme;

function makeSlot(partial: Partial<SubagentSlotResult>): SubagentSlotResult {
	return {
		id: partial.id ?? "slot-1",
		agent: partial.agent ?? "researcher",
		task: partial.task ?? "investigate the auth flow and report risks",
		status: partial.status ?? "running",
		model: partial.model,
		thinking: partial.thinking,
		currentTool: partial.currentTool,
		toolCount: partial.toolCount ?? 0,
		groupId: partial.groupId,
		groupIndex: partial.groupIndex,
		dependsOnSlotIds: partial.dependsOnSlotIds,
		tools: partial.tools ?? [],
		usage: partial.usage ?? emptySubagentUsage(),
		duration: partial.duration ?? { startedAt: Date.now() - 5000, elapsedMs: 5000 },
		output: partial.output ?? { recentOutput: "" },
		error: partial.error,
		cancelled: partial.cancelled,
		outputPath: partial.outputPath,
		attempt: partial.attempt ?? 1,
		previousSlotId: partial.previousSlotId,
	};
}

function makeTool(name: string, status: SubagentToolSnapshot["status"], args: Record<string, unknown>, ageMs = 1200): SubagentToolSnapshot {
	return {
		id: `tool-${Math.random().toString(36).slice(2, 8)}`,
		name,
		status,
		args,
		argsSummary: JSON.stringify(args),
		startedAt: Date.now() - ageMs,
		endedAt: status === "running" ? undefined : Date.now() - Math.max(0, ageMs - 400),
		elapsedMs: status === "running" ? undefined : 400,
	};
}

function singleRunning(): SubagentRunState {
	const slot = makeSlot({
		agent: "researcher",
		status: "running",
		currentTool: "bash",
		toolCount: 4,
		usage: { inputTokens: 800, outputTokens: 420, turns: 3 },
		duration: { startedAt: Date.now() - 5400, elapsedMs: 5400 },
		tools: [
			makeTool("read", "completed", { path: "/repo/Nix/pi.nix/modules/home/extensions/pi-lib/subagents/types.ts" }, 4000),
			makeTool("grep", "completed", { pattern: "SubagentRunState", path: "modules/home" }, 2800),
			makeTool("read", "completed", { path: "/repo/Nix/pi.nix/modules/home/extensions/pi-lib/subagents/engine.ts" }, 1900),
			makeTool("bash", "running", { command: "rg --files modules/home/extensions/pi-lib | head -40" }, 800),
		],
	});
	return baseState({ id: "run-1", mode: "single", label: "subagent researcher", slots: [slot], status: "running" });
}

function singleCompleted(): SubagentRunResult {
	const slot = makeSlot({
		agent: "reviewer",
		status: "completed",
		toolCount: 9,
		usage: { inputTokens: 4200, outputTokens: 1800, turns: 6, costUsd: 0.0142 },
		duration: { startedAt: Date.now() - 73_000, endedAt: Date.now(), elapsedMs: 73_000 },
		output: {
			recentOutput: "",
			finalOutput: [
				"## Findings",
				"",
				"- `tool.ts:60` — schema does not constrain `chain[].parallel` count, allowing 0-length groups.",
				"- `engine.ts:142` — fan-out before plan validation; rerun won't recover dependent slots.",
				"",
				"### Suggested fix",
				"",
				"```ts",
				"if (group.length === 0) throw new Error(\"empty parallel group\");",
				"```",
			].join("\n"),
		},
		model: "anthropic/claude-sonnet-4",
	});
	return baseResult({ id: "run-2", mode: "single", label: "subagent reviewer", slots: [slot], status: "completed" });
}

function parallelInFlight(): SubagentRunState {
	const slots = [
		makeSlot({
			id: "p1", agent: "correctness-reviewer", status: "completed", toolCount: 6,
			usage: { inputTokens: 1800, outputTokens: 900, turns: 4 },
			duration: { startedAt: Date.now() - 41_000, endedAt: Date.now() - 8000, elapsedMs: 33_000 },
		}),
		makeSlot({
			id: "p2", agent: "test-reviewer", status: "running", currentTool: "edit", toolCount: 5,
			usage: { inputTokens: 1500, outputTokens: 600, turns: 3 },
			duration: { startedAt: Date.now() - 38_000, elapsedMs: 38_000 },
			tools: [
				makeTool("read", "completed", { path: "/repo/test/foo.test.ts" }, 12000),
				makeTool("grep", "completed", { pattern: "describe\\(", path: "test" }, 8000),
				makeTool("edit", "running", { path: "/repo/test/foo.test.ts" }, 1100),
			],
		}),
		makeSlot({
			id: "p3", agent: "complexity-reviewer", status: "running", currentTool: "bash", toolCount: 3,
			usage: { inputTokens: 700, outputTokens: 200, turns: 2 },
			duration: { startedAt: Date.now() - 28_000, elapsedMs: 28_000 },
			tools: [
				makeTool("bash", "running", { command: "tokei modules/home/extensions/pi-lib" }, 600),
			],
		}),
	];
	return baseState({ id: "run-3", mode: "parallel", label: "parallel reviewers", slots, status: "running" });
}

function chainMidFlight(): SubagentRunState {
	const slots = [
		makeSlot({
			id: "c1", agent: "scout", status: "completed", toolCount: 7,
			usage: { inputTokens: 2200, outputTokens: 1100, turns: 5 },
			duration: { startedAt: Date.now() - 90_000, endedAt: Date.now() - 30_000, elapsedMs: 60_000 },
		}),
		makeSlot({
			id: "c2", agent: "planner", status: "running", currentTool: "read", toolCount: 4,
			usage: { inputTokens: 1300, outputTokens: 500, turns: 3 },
			duration: { startedAt: Date.now() - 28_000, elapsedMs: 28_000 },
			tools: [
				makeTool("read", "running", { path: "/repo/Nix/pi.nix/modules/home/extensions/pi-lib/subagents/render.ts" }, 1400),
			],
		}),
		makeSlot({
			id: "c3", agent: "worker", status: "pending", toolCount: 0,
			duration: { startedAt: Date.now(), elapsedMs: 0 },
		}),
	];
	return baseState({ id: "run-4", mode: "chain", label: "scout → planner → worker", slots, status: "running" });
}

function parallelMixedFailure(): SubagentRunResult {
	const slots = [
		makeSlot({
			id: "p1", agent: "correctness-reviewer", status: "completed", toolCount: 6,
			usage: { inputTokens: 1800, outputTokens: 900, turns: 4 },
			duration: { startedAt: Date.now() - 41_000, endedAt: Date.now() - 8000, elapsedMs: 33_000 },
			output: { recentOutput: "", finalOutput: "## Correctness\n\nNothing surfaced from a focused read of the diff." },
		}),
		makeSlot({
			id: "p2", agent: "test-reviewer", status: "failed", toolCount: 5, error: "Pi runtime aborted: model returned malformed tool call",
			usage: { inputTokens: 1500, outputTokens: 600, turns: 3 },
			duration: { startedAt: Date.now() - 38_000, endedAt: Date.now() - 1000, elapsedMs: 37_000 },
		}),
	];
	return baseResult({ id: "run-5", mode: "parallel", label: "parallel reviewers", slots, status: "partial" });
}

function baseState(input: Pick<SubagentRunState, "id" | "mode" | "label" | "slots" | "status">): SubagentRunState {
	return {
		...input,
		request: {
			id: input.id, mode: input.mode, label: input.label,
			slots: input.slots.map((slot) => ({ id: slot.id, agent: slot.agent, task: slot.task, model: slot.model, thinking: slot.thinking })),
			cwd: "/repo/Nix/pi.nix", createdAt: Date.now() - 60_000, depth: 0, maxDepth: 3,
		},
		startedAt: Date.now() - 60_000,
		updatedAt: Date.now(),
		events: [],
		rerun: { decision: "not-needed", failedSlotIds: [], rerunSlotIds: [], continuedWithPartialOutput: false },
	};
}

function baseResult(input: Pick<SubagentRunResult, "id" | "mode" | "label" | "slots" | "status">): SubagentRunResult {
	const usage = combineSubagentUsage(input.slots.map((slot) => slot.usage));
	const elapsed = input.slots.reduce((acc, slot) => Math.max(acc, slot.duration.elapsedMs), 0);
	return {
		...input,
		request: {
			id: input.id, mode: input.mode, label: input.label,
			slots: input.slots.map((slot) => ({ id: slot.id, agent: slot.agent, task: slot.task, model: slot.model, thinking: slot.thinking })),
			cwd: "/repo/Nix/pi.nix", createdAt: Date.now() - 60_000, depth: 0, maxDepth: 3,
		},
		usage,
		duration: { startedAt: Date.now() - elapsed, endedAt: Date.now(), elapsedMs: elapsed },
		events: [],
		finalText: input.slots.map((slot) => slot.output.finalOutput ?? "").filter(Boolean).join("\n\n"),
		rerun: { decision: "not-needed", failedSlotIds: [], rerunSlotIds: [], continuedWithPartialOutput: false },
	};
}

function printFrame(label: string, run: SubagentRunState | SubagentRunResult, width: number, expanded: boolean): void {
	const heading = `── ${label} · width=${width} · ${expanded ? "expanded" : "compact"} `;
	console.log(`\n${heading}${"─".repeat(Math.max(0, width - heading.length))}`);
	const component = renderSubagentRun(run, { expanded, width }, fakeTheme);
	for (const line of component.render(width)) console.log(line);
}

const fixtures: Array<[string, SubagentRunState | SubagentRunResult]> = [
	["single running", singleRunning()],
	["single completed", singleCompleted()],
	["parallel in flight", parallelInFlight()],
	["chain mid flight", chainMidFlight()],
	["parallel partial failure", parallelMixedFailure()],
];

for (const [label, run] of fixtures) {
	for (const width of [100, 60]) {
		for (const expanded of [false, true]) printFrame(label, run, width, expanded);
	}
}
