import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { workflowController } from "../workflow/controller.ts";
import { prepareManualHandoff, unsafeAutomaticHandoffReason } from "../workflow/handoff.ts";
import { getWorkflowProfile } from "../workflow/profiles.ts";
import { makeStageDir, writeStage } from "../spec/stage.ts";
import {
	cleanupApplyPrompt,
	cleanupEfficiencyTask,
	cleanupQualityTask,
	cleanupQuickPrompt,
	cleanupReuseTask,
} from "./prompts.ts";
import { extractSubagentText, runSubagent } from "./subagent-runner.ts";

const CLEANUP_PROFILE_ID = "cleanup";

function exitCleanupController(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
	if (!workflowController.activeRun) return;
	if (workflowController.activeRun.profile.id !== CLEANUP_PROFILE_ID) return;
	try {
		workflowController.exit(pi, ctx, reason);
	} catch (error) {
		ctx.ui.notify(`/cleanup workflow exit failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

export function registerCleanupCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cleanup", {
		description: "Review changed files (reuse, quality, efficiency) and apply fixes.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const focus = args?.trim() || undefined;

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

			try {
				workflowController.enter(pi, ctx, getWorkflowProfile(CLEANUP_PROFILE_ID));
			} catch (error) {
				ctx.ui.notify(`/cleanup cannot start workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const stageDir = makeStageDir("cleanup");
			const diffPath = writeStage(stageDir, "diff", diffText);
			ctx.ui.notify("/cleanup: launching reuse, quality, and efficiency scouts.", "info");

			try {
				const response = await runSubagent(pi, ctx, {
					tasks: [
						{ agent: "cleanup.cleanup-reuse-scout", task: cleanupReuseTask(diffPath, focus) },
						{ agent: "cleanup.cleanup-quality-scout", task: cleanupQualityTask(diffPath, focus) },
						{ agent: "cleanup.cleanup-efficiency-scout", task: cleanupEfficiencyTask(diffPath, focus) },
					],
					context: "fresh",
					agentScope: "both",
				}, "/cleanup scouts");
				const findings = extractSubagentText(response);
				const findingsPath = writeStage(stageDir, "findings", findings);
				ctx.ui.notify("/cleanup: scouts complete. Manual handoff prepared for parent agent to apply fixes.", "info");
				await prepareManualHandoff(ctx, {
					label: "/cleanup apply",
					command: cleanupApplyPrompt({ diffPath, findingsPath, focus }),
					reason: unsafeAutomaticHandoffReason(),
				}, { pi });
			} catch (error) {
				exitCleanupController(pi, ctx, "scout_failed");
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
			await prepareManualHandoff(ctx, {
				label: "/cleanup:quick",
				command: cleanupQuickPrompt(),
				reason: unsafeAutomaticHandoffReason(),
			}, { pi });
		},
	});

	pi.registerCommand("cleanup:exit", {
		description: "Exit the /cleanup workflow and restore prior tools.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			exitCleanupController(pi, ctx, "user_exit");
			ctx.ui.notify("/cleanup workflow exited.", "info");
		},
	});
}
