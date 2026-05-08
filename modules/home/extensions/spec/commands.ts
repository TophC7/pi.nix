import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { prepareManualHandoff, unsafeAutomaticHandoffReason } from "../workflow/handoff.ts";
import { enterMode, exitMode, state } from "./mode.ts";
import { isPlanDraftPath, parsePlanCommand, pickPlan } from "./plans.ts";
import {
	planFinalizePrompt,
	planRiskScoutTask,
	planScoutTask,
	specFinalizePrompt,
	specVerifierTask,
} from "./prompts.ts";
import { extractInvariantChecks, extractIssueIds, extractManualChecks, extractRunChecks, readSpecFiles, replaceSyncBlock, resolveSpec } from "./spec-files.ts";
import { bridgeInfo, formatBridgeError, formatCounts, formatState, loadSpecSwormState, requireSwormBridge, resolveSpecEpicId, specWorkPrompt } from "./issues.ts";
import { extractSubagentText, runSubagent } from "./subagent-runner.ts";

function makeStageDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pi-${prefix}-`));
}

function writeStage(dir: string, name: string, content: string): string {
	const path = join(dir, `${name}.md`);
	writeFileSync(path, content, "utf8");
	return path;
}

async function requireBridgeOrExit(pi: ExtensionAPI, ctx: ExtensionCommandContext, action: string): Promise<boolean> {
	if (await requireSwormBridge(ctx)) return true;
	const exited = state.mode !== "idle";
	if (exited) exitMode(pi, ctx);
	ctx.ui.notify(`${action} failed: Sworm issue bridge unavailable.${exited ? " Workflow mode exited." : ""}`, "error");
	return false;
}

export function registerPlanCommands(pi: ExtensionAPI): void {
	pi.registerCommand("plan", {
		description: "Draft read-only plan. Args: open, promote, exit.",
		getArgumentCompletions: (prefix: string) => ["open", "promote", "exit", "help"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const command = parsePlanCommand(args);
			if (command === "exit") {
				exitMode(pi, ctx);
				ctx.ui.notify("Plan mode exited.", "info");
				return;
			}
			if (command === "open") {
				const draft = await pickPlan(ctx, "Open plan draft:");
				if (!draft) return;
				prepareManualHandoff(ctx, {
					label: "/plan open",
					command: `/preview ${draft.path}`,
					reason: unsafeAutomaticHandoffReason(),
				});
				return;
			}
			if (command === "promote") {
				const draft = await pickPlan(ctx, "Promote plan draft:");
				if (!draft) return;
				if (!(await requireBridgeOrExit(pi, ctx, "/plan promote"))) return;
				exitMode(pi, ctx);
				prepareManualHandoff(ctx, {
					label: "/plan promote",
					command: `/spec:new ${draft.path}`,
					reason: unsafeAutomaticHandoffReason(),
				});
				return;
			}
			if (command === "help") {
				ctx.ui.notify("Usage: /plan <description> | /plan open | /plan promote | /plan exit", "info");
				return;
			}
			let description = args?.trim() ?? "";
			if (!description) {
				const entered = await ctx.ui.input("/plan idea", "Describe the idea to harden");
				description = entered?.trim() ?? "";
				if (!description) {
					ctx.ui.notify("/plan cancelled: no idea provided.", "warning");
					return;
				}
			}
			enterMode(pi, ctx, "plan-authoring");
			ctx.ui.notify("/plan: exploring with spec subagents before drafting.", "info");
			const stageDir = makeStageDir("plan");
			try {
				const scoutResponse = await runSubagent(pi, ctx, {
					tasks: [
						{ agent: "spec.plan-scout", task: planScoutTask(description), output: false },
						{ agent: "spec.plan-risk-scout", task: planRiskScoutTask(description), output: false },
					],
					context: "fresh",
					clarify: false,
					agentScope: "both",
				}, "/plan scout");
				const findings = extractSubagentText(scoutResponse);
				const findingsPath = writeStage(stageDir, "findings", findings);
				ctx.ui.notify("Plan discovery complete. Manual handoff prepared for parent agent interview, synthesis, hardening, and save.", "info");
				prepareManualHandoff(ctx, {
					label: "/plan finalize",
					command: planFinalizePrompt({ description, findingsPath }),
					reason: unsafeAutomaticHandoffReason(),
				});
			} catch (error) {
				exitMode(pi, ctx);
				ctx.ui.notify(formatBridgeError(error), "error");
			}
		},
	});
}

export function registerSpecCommands(pi: ExtensionAPI): void {
	pi.registerCommand("spec:new", {
		description: "Create durable Sworm-backed spec from selected plan draft.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!(await requireBridgeOrExit(pi, ctx, "/spec:new"))) return;
			let planPath = args?.trim() ?? "";
			if (!planPath) {
				const choice = await ctx.ui.select("/spec:new needs a plan draft", ["select existing plan", "create new /plan", "cancel"]);
				if (choice === "create new /plan") {
					prepareManualHandoff(ctx, {
						label: "/spec:new",
						command: "/plan",
						reason: unsafeAutomaticHandoffReason(),
					});
					return;
				}
				if (choice !== "select existing plan") return;
				const draft = await pickPlan(ctx, "Select plan for /spec:new:");
				if (!draft) return;
				planPath = draft.path;
			}
			if (!isPlanDraftPath(planPath) || !existsSync(planPath)) {
				ctx.ui.notify(`Plan draft not found or invalid .sworm/plans/YYYY-MM-DD-<slug>.md path: ${planPath}`, "error");
				return;
			}
			enterMode(pi, ctx, "spec-authoring");
			ctx.ui.notify("/spec:new: verifying plan with spec subagents before durable writes.", "info");
			const stageDir = makeStageDir("spec");
			try {
				const verifierResponse = await runSubagent(pi, ctx, {
					agent: "spec.spec-verifier",
					task: specVerifierTask(planPath),
					context: "fresh",
					clarify: false,
					agentScope: "both",
					output: false,
				}, "/spec verify");
				const verification = extractSubagentText(verifierResponse);
				const verificationPath = writeStage(stageDir, "verification", verification);
				ctx.ui.notify("Spec verification complete. Manual handoff prepared for parent agent interview, draft, review, hardening, and save.", "info");
				prepareManualHandoff(ctx, {
					label: "/spec:new finalize",
					command: specFinalizePrompt({ planPath, verificationPath }),
					reason: unsafeAutomaticHandoffReason(),
				});
			} catch (error) {
				exitMode(pi, ctx);
				ctx.ui.notify(formatBridgeError(error), "error");
			}
		},
	});

	pi.registerCommand("spec:work", {
		description: "Execute ready Sworm spec issues continuously.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!(await requireSwormBridge(ctx))) return;
			const spec = await resolveSpec(ctx, args);
			if (!spec) return;
			try {
				const swormState = await loadSpecSwormState(spec);
				enterMode(pi, ctx, "spec-working");
				prepareManualHandoff(ctx, {
					label: "/spec:work",
					command: specWorkPrompt(spec, swormState),
					reason: unsafeAutomaticHandoffReason(),
				});
			} catch (error) {
				exitMode(pi, ctx);
				ctx.ui.notify(formatBridgeError(error), "error");
			}
		},
	});

	pi.registerCommand("spec:sync", {
		description: "Sync spec Current State from Sworm issues.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!(await requireSwormBridge(ctx))) return;
			const spec = await resolveSpec(ctx, args);
			if (!spec) return;
			try {
				const before = readFileSync(spec.indexPath, "utf8");
				const swormState = await loadSpecSwormState(spec);
				const block = [
					`**Last synced**: ${new Date().toISOString()}`,
					`**Sworm epic**: ${swormState.epic.id} · ${swormState.epic.title} (${swormState.epic.status})`,
					`**Progress**: ${formatCounts(swormState.summary.counts)}`,
					`**Ready next**: ${swormState.summary.readyLine}`,
					`**Blockers**: ${swormState.summary.blockers.length ? swormState.summary.blockers.join("; ") : "none"}`,
					`**Manual checks**: ${swormState.summary.manualChecks.length ? swormState.summary.manualChecks.join("; ") : "none recorded"}`,
				].join("\n");
				const after = replaceSyncBlock(before, block);
				writeFileSync(spec.indexPath, after);
				const changedOutside = before.replace(/<!-- spec-sync:start -->[\s\S]*?<!-- spec-sync:end -->/, "") !== after.replace(/<!-- spec-sync:start -->[\s\S]*?<!-- spec-sync:end -->/, "");
				ctx.ui.notify(`Synced ${spec.indexPath}${changedOutside ? " (warning: outside marker changed)" : ""}`, changedOutside ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(formatBridgeError(error), "error");
			}
		},
	});

	pi.registerCommand("spec:check", {
		description: "Read-only Sworm/spec drift report.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!(await requireSwormBridge(ctx))) return;
			const spec = await resolveSpec(ctx, args);
			if (!spec) return;
			const before = readdirSync(spec.path).filter((name) => name.endsWith(".md")).map((name) => [join(spec.path, name), readFileSync(join(spec.path, name), "utf8")] as const);
			const content = readSpecFiles(spec);
			const runChecks = extractRunChecks(content);
			const manualChecks = extractManualChecks(content);
			const invariantChecks = extractInvariantChecks(content);
			const failures: string[] = [];
			for (const command of [...runChecks, ...invariantChecks]) {
				const result = await pi.exec("fish", ["-lc", command], { cwd: ctx.cwd, signal: ctx.signal, timeout: 120000 });
				if ((result.code ?? 1) !== 0) failures.push(`${command}\n${result.stderr || result.stdout}`.trim());
			}
			const afterChanged = before.filter(([path, text]) => readFileSync(path, "utf8") !== text).map(([path]) => path);
			if (afterChanged.length) failures.push(`/spec:check mutated files: ${afterChanged.join(", ")}`);
			const epicId = resolveSpecEpicId(spec, content);
			if (!epicId) failures.push("Missing Sworm EPIC id (frontmatter sworm_epic_id or EPIC-* in spec). ");
			let swormState;
			try {
				swormState = await loadSpecSwormState(spec);
				const knownIds = new Set(swormState.issues.map((issue) => issue.id));
				const unknownIds = extractIssueIds(content).filter((id) => !knownIds.has(id));
				if (unknownIds.length) failures.push(`Spec references unknown Sworm issues: ${unknownIds.join(", ")}`);
			} catch (error) {
				failures.push(formatBridgeError(error));
			}
			const bugs = content.split("\n").filter((line) => /^\|\s*B-/.test(line));
			const missingIds = content.split("\n").filter((line) => /^\|\s*(pending|—)\s*\|/.test(line));
			if (missingIds.length) failures.push(`Missing Sworm ISSUE ids:\n${missingIds.join("\n")}`);
			const verdict = failures.length === 0 ? "PASS" : "FAIL";
			ctx.ui.notify([
				`/spec:check ${verdict}: ${spec.name}`,
				`shape: ${spec.shape}`,
				`Sworm epic: ${swormState?.epic.id ?? epicId ?? "missing"}`,
				`issues: ${swormState ? formatCounts(swormState.summary.counts) : "unavailable"}`,
				`ready next: ${swormState?.summary.readyLine ?? "none"}`,
				`run checks: ${runChecks.length}`,
				`invariant checks: ${invariantChecks.length}`,
				`manual checks not run: ${manualChecks.length}`,
				`§B rows: ${bugs.length}`,
				...failures.map((failure) => `FAILED:\n${failure}`),
			].join("\n"), failures.length === 0 ? "info" : "error");
		},
	});

	pi.registerCommand("spec:status", {
		description: "Show Sworm spec workflow status.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const spec = await resolveSpec(ctx, args);
			const askClaude = pi.getAllTools().some((tool) => tool.name === "AskClaude" || /claude/i.test(`${tool.name} ${tool.description ?? ""}`));
			let infoText = "unavailable";
			let stateText = "No active spec.";
			let ok = false;
			try {
				const info = await bridgeInfo();
				infoText = JSON.stringify(info);
				ok = true;
				if (spec) stateText = formatState(await loadSpecSwormState(spec));
			} catch (error) {
				infoText = formatBridgeError(error);
			}
			ctx.ui.notify([
				`Mode: ${state.mode}`,
				`Active spec: ${spec ? `${spec.name} [${spec.shape}] · ${spec.path}` : "none"}`,
				`AskClaude: ${askClaude ? "available" : "missing"}`,
				`Sworm bridge: ${infoText}`,
				stateText,
			].join("\n"), ok ? "info" : "error");
		},
	});

	pi.registerCommand("spec:exit", {
		description: "Exit plan/spec tool-gated workflow mode.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			exitMode(pi, ctx);
			ctx.ui.notify("Spec workflow mode exited.", "info");
		},
	});
}
