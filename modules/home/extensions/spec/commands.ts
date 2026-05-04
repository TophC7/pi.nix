import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { enterMode, exitMode, state } from "./mode.ts";
import { parsePlanCommand, pickPlan } from "./plans.ts";
import { planPrompt, specNewPrompt } from "./prompts.ts";
import { extractInvariantChecks, extractManualChecks, extractRunChecks, readSpecFiles, replaceSyncBlock, resolveSpec } from "./spec-files.ts";
import { collectSpecComments, collectSpecTaskOutput, formatCounts, processAlive, readDashboardMeta, runTrekker, summarizeTasks } from "./trekker.ts";

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
				pi.sendUserMessage(`/preview ${draft.path}`);
				return;
			}
			if (command === "promote") {
				const draft = await pickPlan(ctx, "Promote plan draft:");
				if (!draft) return;
				pi.sendUserMessage(`/spec:new ${draft.path}`);
				return;
			}
			if (command === "help") {
				ctx.ui.notify("Usage: /plan <description> | /plan open | /plan promote | /plan exit", "info");
				return;
			}
			enterMode(pi, ctx, "plan-authoring");
			ctx.ui.notify("Plan authoring mode active. save_plan_draft is only write path.", "info");
			pi.sendUserMessage(planPrompt(args?.trim() ?? ""));
		},
	});
}

export function registerSpecCommands(pi: ExtensionAPI): void {
	pi.registerCommand("spec:new", {
		description: "Create durable spec from selected plan draft.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			let planPath = args?.trim() ?? "";
			if (!planPath) {
				const choice = await ctx.ui.select("/spec:new needs a plan draft", ["select existing plan", "create new /plan", "cancel"]);
				if (choice === "create new /plan") {
					pi.sendUserMessage("/plan");
					return;
				}
				if (choice !== "select existing plan") return;
				const draft = await pickPlan(ctx, "Select plan for /spec:new:");
				if (!draft) return;
				planPath = draft.path;
			}
			if (!planPath.startsWith(".sworm/plans/") || !existsSync(planPath)) {
				ctx.ui.notify(`Plan draft not found or outside .sworm/plans/: ${planPath}`, "error");
				return;
			}
			enterMode(pi, ctx, "spec-authoring");
			ctx.ui.notify("Spec authoring mode active. save_spec and trekker are durable write paths.", "info");
			pi.sendUserMessage(specNewPrompt(planPath));
		},
	});

	pi.registerCommand("spec:work", {
		description: "Execute ready Trekker spec tasks continuously.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const spec = await resolveSpec(ctx, args);
			if (!spec) return;
			enterMode(pi, ctx, "spec-working");
			const ready = await runTrekker(pi, ["ready", "--limit", "1"], ctx);
			if (ready.code !== 0) {
				ctx.ui.notify(`trekker ready failed:\n${ready.stderr || ready.stdout}`, "error");
				return;
			}
			pi.sendUserMessage(`Run /spec:work for ${spec.path}

Spec shape: ${spec.shape}

Rules:
- Read every markdown file in ${spec.path} before editing.
- Use Trekker ready state, not markdown order.
- Claim first ready TASK by running: trekker task update <TASK-ID> -s in_progress.
- Restore implementation discipline: inspect reuse before abstractions, avoid scope creep.
- Run every runnable run: acceptance check for each completed task under Fish.
- Record manual: checks as Trekker comments and final summary; manual checks do not block automated close.
- Complete with: trekker comment add <TASK-ID> -a pi -c "Automated checks passed. Manual checks delegated: <list or none>." then trekker task update <TASK-ID> -s completed.
- Continue ready queue until no ready task remains or true blocker appears.
- On true blocker, add Trekker comment, update §B in relevant spec file, ask_user with recovery options, stop.

Initial ready output:
${ready.stdout || "No ready tasks."}`);
		},
	});

	pi.registerCommand("spec:sync", {
		description: "Sync spec Current State from Trekker.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const spec = await resolveSpec(ctx, args);
			if (!spec) return;
			const before = readFileSync(spec.indexPath, "utf8");
			const [epics, tasks, ready, comments] = await Promise.all([
				runTrekker(pi, ["epic", "list", "--limit", "200"], ctx),
				collectSpecTaskOutput(pi, spec, ctx),
				runTrekker(pi, ["ready", "--limit", "20"], ctx),
				collectSpecComments(pi, spec, ctx),
			]);
			const summary = summarizeTasks(spec, tasks, ready.stdout, comments);
			const epicLine = epics.stdout.split("\n").find((line) => /SPEC-\d+/.test(line) && /Pi Spec Workflow|spec/i.test(line)) ?? "see Trekker";
			const block = [
				`**Last synced**: ${new Date().toISOString()}`,
				`**Trekker epic**: ${epicLine}`,
				`**Progress**: ${formatCounts(summary.counts)}`,
				`**Ready next**: ${summary.readyLine}`,
				`**Blockers**: ${summary.blockers.length ? summary.blockers.join("; ") : "none"}`,
				`**Manual checks**: ${summary.manualChecks.length ? summary.manualChecks.join("; ") : "none recorded"}`,
			].join("\n");
			const after = replaceSyncBlock(before, block);
			writeFileSync(spec.indexPath, after);
			const changedOutside = before.replace(/<!-- spec-sync:start -->[\s\S]*?<!-- spec-sync:end -->/, "") !== after.replace(/<!-- spec-sync:start -->[\s\S]*?<!-- spec-sync:end -->/, "");
			ctx.ui.notify(`Synced ${spec.indexPath}${changedOutside ? " (warning: outside marker changed)" : ""}`, changedOutside ? "error" : "info");
		},
	});

	pi.registerCommand("spec:check", {
		description: "Read-only spec drift report.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
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
			const [tasks, ready, comments] = await Promise.all([
				collectSpecTaskOutput(pi, spec, ctx),
				runTrekker(pi, ["ready", "--limit", "20"], ctx),
				collectSpecComments(pi, spec, ctx),
			]);
			const summary = summarizeTasks(spec, tasks, ready.stdout, comments);
			const bugs = content.split("\n").filter((line) => /^\|\s*B-/.test(line));
			const missingIds = content.split("\n").filter((line) => /^\|\s*(pending|—)\s*\|/.test(line));
			if (afterChanged.length) failures.push(`/spec:check mutated files: ${afterChanged.join(", ")}`);
			if (missingIds.length) failures.push(`Missing Trekker IDs:\n${missingIds.join("\n")}`);
			const verdict = failures.length === 0 ? "PASS" : "FAIL";
			ctx.ui.notify([
				`/spec:check ${verdict}: ${spec.name}`,
				`shape: ${spec.shape}`,
				`tasks: ${formatCounts(summary.counts)}`,
				`ready next: ${summary.readyLine}`,
				`run checks: ${runChecks.length}`,
				`invariant checks: ${invariantChecks.length}`,
				`manual checks not run: ${manualChecks.length}`,
				`§B rows: ${bugs.length}`,
				...failures.map((failure) => `FAILED:\n${failure}`),
			].join("\n"), failures.length === 0 ? "info" : "error");
		},
	});

	pi.registerCommand("spec:status", {
		description: "Show spec workflow status.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const spec = await resolveSpec(ctx, args);
			const askClaude = pi.getAllTools().some((tool) => tool.name === "AskClaude" || /claude/i.test(`${tool.name} ${tool.description ?? ""}`));
			const trekker = await runTrekker(pi, ["--help"], ctx);
			const [tasks, ready, comments] = spec && trekker.code === 0 ? await Promise.all([
				collectSpecTaskOutput(pi, spec, ctx),
				runTrekker(pi, ["ready", "--limit", "20"], ctx),
				collectSpecComments(pi, spec, ctx),
			]) : ["", { stdout: "", stderr: "", code: 1 }, ""] as const;
			const summary = spec ? summarizeTasks(spec, tasks, ready.stdout, comments) : undefined;
			const dashboardMeta = readDashboardMeta(".sworm/trekker/dashboard.json");
			const dashboard = dashboardMeta.url && dashboardMeta.pid && processAlive(dashboardMeta.pid) ? `${dashboardMeta.url} (pid ${dashboardMeta.pid})` : "not running";
			ctx.ui.notify([
				`Mode: ${state.mode}`,
				`Active spec: ${spec ? `${spec.name} [${spec.shape}] · ${spec.path}` : "none"}`,
				`AskClaude: ${askClaude ? "available" : "missing"}`,
				`Trekker helper: ${trekker.code === 0 ? "ok" : "failed"}`,
				`Tasks: ${summary ? formatCounts(summary.counts) : "unavailable"}`,
				`Ready next: ${summary?.readyLine ?? "none"}`,
				`Blockers: ${summary?.blockers.length ? summary.blockers.join("; ") : "none"}`,
				`Manual checks: ${summary?.manualChecks.length ? summary.manualChecks.join("; ") : "none recorded"}`,
				`Dashboard: ${dashboard}`,
			].join("\n"), trekker.code === 0 ? "info" : "error");
		},
	});

	pi.registerCommand("spec:exit", {
		description: "Exit plan/spec tool-gated workflow mode.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			exitMode(pi, ctx);
			ctx.ui.notify("Spec workflow mode exited. Dashboard untouched; use /trekker stop for dashboard.", "info");
		},
	});
}
