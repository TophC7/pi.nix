import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { prepareManualHandoff, unsafeAutomaticHandoffReason } from "../workflow/handoff.ts";
import { enterMode, exitMode } from "./mode.ts";
import { reviewFinalizePrompt } from "./prompts.ts";
import { captureReviewContext } from "./review-context.ts";
import { REVIEW_AGENT_REGISTRY, type ReviewScope } from "./review-schema.ts";
import { validateReviewPlanDraft } from "./review-plan-validator.ts";
import { synthesizeReview } from "./review-synthesis.ts";
import { formatReviewTarget, parseReviewTarget, REVIEW_TARGET_USAGE, type ReviewTarget } from "./review-targets.ts";
import { makeStageDir, writeStage } from "./stage.ts";
import { extractSubagentText, runSubagent } from "./subagent-runner.ts";

function parseReviewArgs(args: string | undefined): "help" | "exit" | string {
	const trimmed = args?.trim() ?? "";
	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") return "help";
	if (trimmed === "exit" || trimmed === "cancel") return "exit";
	return trimmed;
}

async function captureTarget(ctx: ExtensionCommandContext, initialTarget: string): Promise<string | undefined> {
	if (initialTarget) return initialTarget;
	const entered = await ctx.ui.input("/plan:review target", "Review target (example: working-tree)");
	const target = entered?.trim() ?? "";
	return target || undefined;
}

async function parseReviewTargetWithPasteBody(ctx: ExtensionCommandContext, targetText: string): Promise<ReturnType<typeof parseReviewTarget>> {
	if (targetText.trim() !== "paste") return parseReviewTarget(targetText);
	const content = await ctx.ui.editor("Paste review content", "");
	if (!content?.trim()) return { ok: false, error: "Target 'paste' requires non-empty content." };
	return { ok: true, target: { kind: "paste", content } };
}

function reviewAgentTask(scope: ReviewScope, target: ReviewTarget, contextPath: string): string {
	return [
		`Review scope: ${scope}`,
		`Target: ${formatReviewTarget(target)}`,
		`Context file: ${contextPath}`,
		"",
		"Read the context file first, then inspect only repository files needed to verify findings.",
		"Return review cards for this scope only, using your required schema. If no findings, return exactly `No findings.`.",
	].join("\n");
}

export function registerPlanReviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("plan:review", {
		description: "Draft adversarial review plan from a target. Args: working-tree, staged, range, branch, paths, paste, freeform.",
		getArgumentCompletions: (prefix: string) => ["working-tree", "staged", "range ", "branch ", "paths ", "paste", "freeform ", "exit", "help"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value.trim() || value })),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const command = parseReviewArgs(args);
			if (command === "help") {
				ctx.ui.notify(`Usage: /plan:review <target> where target is ${REVIEW_TARGET_USAGE}. Use /plan:review exit to restore tools.`, "info");
				return;
			}
			if (command === "exit") {
				exitMode(pi, ctx);
				ctx.ui.notify("Plan review mode exited.", "info");
				return;
			}

			enterMode(pi, ctx, "plan-review-authoring");
			try {
				const targetText = await captureTarget(ctx, command);
				if (!targetText) {
					exitMode(pi, ctx);
					ctx.ui.notify("/plan:review cancelled: no target provided.", "warning");
					return;
				}
				const parsed = await parseReviewTargetWithPasteBody(ctx, targetText);
				if (!parsed.ok) {
					exitMode(pi, ctx);
					ctx.ui.notify(`/plan:review invalid target: ${parsed.error}`, "error");
					return;
				}
				const stageDir = makeStageDir("plan-review");
				const context = await captureReviewContext(pi, ctx, parsed.target);
				const contextPath = writeStage(stageDir, "context", context.content);
				const suffix = context.truncated ? ` Truncation notes: ${context.notes.join(" ")}` : "";
				ctx.ui.notify(`/plan:review target resolved: ${formatReviewTarget(parsed.target)}. Context captured at ${contextPath} (${context.bytes} bytes). Launching six review agents.${suffix}`, "info");
				const response = await runSubagent(pi, ctx, {
					tasks: REVIEW_AGENT_REGISTRY.map(({ agent, scope }) => ({
						agent,
						task: reviewAgentTask(scope, parsed.target, contextPath),
						output: false,
					})),
					context: "fresh",
					clarify: false,
					agentScope: "both",
				}, "/plan:review agents");
				const rawFindings = extractSubagentText(response);
				const findingsPath = writeStage(stageDir, "raw-findings", rawFindings);
				const synthesis = synthesizeReview(rawFindings, parsed.target);
				const draftValidation = validateReviewPlanDraft(synthesis.planDraft, { requireHardening: false });
				if (!draftValidation.valid) throw new Error(`Generated review plan draft failed validation:\n${draftValidation.errors.join("\n")}`);
				const reportPath = writeStage(stageDir, "report", synthesis.report);
				if (synthesis.findings.length === 0) {
					const choice = await ctx.ui.select("/plan:review found no issues", ["report only", "create empty plan draft"]);
					if (choice === "create empty plan draft") {
						const planDraftPath = writeStage(stageDir, "plan-draft", synthesis.planDraft);
						ctx.ui.notify(`/plan:review agents complete with no findings. Report: ${reportPath}. Empty draft created by user opt-in: ${planDraftPath}.`, "info");
						prepareManualHandoff(ctx, {
							label: "/plan:review finalize",
							command: reviewFinalizePrompt({ target: formatReviewTarget(parsed.target), reportPath, planDraftPath }),
							reason: unsafeAutomaticHandoffReason(),
						});
					} else {
						ctx.ui.notify(`/plan:review agents complete with no findings. Report: ${reportPath}. No plan draft created.`, "info");
						exitMode(pi, ctx);
					}
					return;
				}
				const planDraftPath = writeStage(stageDir, "plan-draft", synthesis.planDraft);
				ctx.ui.notify(`/plan:review agents complete. Raw findings: ${findingsPath}. Report: ${reportPath}. Plan-compatible draft: ${planDraftPath}. Manual handoff prepared for hardening and save.`, "info");
				prepareManualHandoff(ctx, {
					label: "/plan:review finalize",
					command: reviewFinalizePrompt({ target: formatReviewTarget(parsed.target), reportPath, planDraftPath }),
					reason: unsafeAutomaticHandoffReason(),
				});
			} catch (error) {
				exitMode(pi, ctx);
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/plan:review failed: ${message}`, "error");
			}
		},
	});
}
