import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { prepareManualHandoff, unsafeAutomaticHandoffReason } from "../workflow/handoff.ts";
import { getWorkflowProfile } from "../workflow/profiles.ts";
import { missingRequiredToolNames } from "../workflow/tools.ts";
import {
	cleanupApplyPrompt,
	cleanupEfficiencyTask,
	cleanupQualityTask,
	cleanupQuickPrompt,
	cleanupReuseTask,
} from "./prompts.ts";
import { extractSubagentText, runSubagent } from "./subagent-runner.ts";

function makeStageDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-cleanup-"));
}

function writeStage(dir: string, name: string, content: string): string {
	const path = join(dir, `${name}.md`);
	writeFileSync(path, content, "utf8");
	return path;
}

export function registerCleanupCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cleanup", {
		description: "Review changed files (reuse, quality, efficiency) and apply fixes.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const focus = args?.trim() || undefined;
			const missingTools = missingRequiredToolNames(getWorkflowProfile("cleanup"), pi.getAllTools().map((tool) => tool.name));
			if (missingTools.length > 0) {
				ctx.ui.notify(`/cleanup missing required tool(s): ${missingTools.join(", ")}. Failing closed.`, "error");
				return;
			}

			const repoCheck = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd: ctx.cwd, signal: ctx.signal });
			if ((repoCheck.code ?? 1) !== 0) {
				ctx.ui.notify("/cleanup requires a git repository.", "error");
				return;
			}
			const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, signal: ctx.signal });
			if (!status.stdout.trim()) {
				ctx.ui.notify("/cleanup: no working-tree changes to review.", "info");
				return;
			}
			const diff = await pi.exec("git", ["diff", "HEAD"], { cwd: ctx.cwd, signal: ctx.signal });
			const diffText = (diff.stdout || "").trim();
			if (!diffText) {
				ctx.ui.notify("/cleanup: working tree changes produced an empty diff.", "warning");
				return;
			}

			const stageDir = makeStageDir();
			const diffPath = writeStage(stageDir, "diff", diffText);
			ctx.ui.notify("/cleanup: launching reuse, quality, and efficiency scouts.", "info");

			try {
				const response = await runSubagent(pi, ctx, {
					tasks: [
						{ agent: "cleanup.cleanup-reuse-scout", task: cleanupReuseTask(diffPath, focus), output: false },
						{ agent: "cleanup.cleanup-quality-scout", task: cleanupQualityTask(diffPath, focus), output: false },
						{ agent: "cleanup.cleanup-efficiency-scout", task: cleanupEfficiencyTask(diffPath, focus), output: false },
					],
					context: "fresh",
					clarify: false,
					agentScope: "both",
				}, "/cleanup scouts");
				const findings = extractSubagentText(response);
				const findingsPath = writeStage(stageDir, "findings", findings);
				ctx.ui.notify("/cleanup: scouts complete. Manual handoff prepared for parent agent to apply fixes.", "info");
				prepareManualHandoff(ctx, {
					label: "/cleanup apply",
					command: cleanupApplyPrompt({ diffPath, findingsPath, focus }),
					reason: unsafeAutomaticHandoffReason(),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/cleanup error: ${message}`, "error");
				throw error;
			}
		},
	});

	pi.registerCommand("cleanup:quick", {
		description: "Delete only obvious junk (console.log, debugger, unused imports, empty catches).",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.notify("/cleanup:quick: manual handoff prepared for obvious junk removal.", "info");
			prepareManualHandoff(ctx, {
				label: "/cleanup:quick",
				command: cleanupQuickPrompt(),
				reason: unsafeAutomaticHandoffReason(),
			});
		},
	});
}
