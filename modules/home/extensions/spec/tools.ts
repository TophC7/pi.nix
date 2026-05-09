import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { prepareManualHandoff, unsafeAutomaticHandoffReason } from "../workflow/handoff.ts";
import { saveFile } from "./files.ts";
import { requireSwormBridge } from "./issues.ts";
import { exitMode } from "./mode.ts";
import { isPlanDraftPath } from "./plans.ts";
import { validateReviewPlanDraft } from "./review-plan-validator.ts";

export function registerSpecWorkflowTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "save_plan_draft",
		label: "Save Plan Draft",
		description: "Save AskClaude-hardened plan draft under .sworm/plans/ only.",
		parameters: Type.Object({
			path: Type.String({ description: ".sworm/plans/YYYY-MM-DD-<slug>.md" }),
			content: Type.String({ description: "Complete markdown plan with required frontmatter" }),
		}),
		async execute(_toolCallId, params) {
			if (!isPlanDraftPath(params.path)) {
				throw new Error("Plan path must match .sworm/plans/YYYY-MM-DD-<slug>.md");
			}
			const reviewValidation = validateReviewPlanDraft(params.content);
			if (!reviewValidation.valid) {
				throw new Error(`Invalid review plan draft:\n${reviewValidation.errors.join("\n")}`);
			}
			const result = saveFile(".sworm/plans", params.path, params.content, true);
			return { content: [{ type: "text", text: `Saved ${result.path} (${result.bytes} bytes).` }], details: result };
		},
	});

	pi.registerTool({
		name: "promote_plan",
		label: "Promote Plan to Spec",
		description: "Hand off a saved .sworm/plans/<file>.md to /spec:new. Exits plan-authoring mode and triggers spec-authoring (which is where Sworm issue creation runs). Use only after save_plan_draft has succeeded and the user has chosen to promote.",
		parameters: Type.Object({
			path: Type.String({ description: "Path returned by save_plan_draft, e.g. .sworm/plans/2026-05-07-my-plan.md" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isPlanDraftPath(params.path)) {
				throw new Error("promote_plan path must match .sworm/plans/YYYY-MM-DD-<slug>.md");
			}
			if (!(await requireSwormBridge(ctx))) {
				exitMode(pi, ctx);
				const text = `Promotion failed for ${params.path}: Sworm issue bridge unavailable. Plan mode exited.`;
				ctx.ui.notify(text, "error");
				return { content: [{ type: "text" as const, text }], details: { path: params.path, error: "sworm_bridge_unavailable" }, isError: true };
			}
			exitMode(pi, ctx);
			const text = prepareManualHandoff(ctx, {
				label: "promote_plan",
				command: `/spec:new ${params.path}`,
				reason: unsafeAutomaticHandoffReason(),
			});
			return { content: [{ type: "text", text }], details: { path: params.path, manualHandoff: true } };
		},
	});

	pi.registerTool({
		name: "save_spec",
		label: "Save Spec",
		description: "Save AskClaude-hardened spec markdown under .sworm/spec/<name>/ only.",
		parameters: Type.Object({
			path: Type.String({ description: ".sworm/spec/<name>/...md" }),
			content: Type.String({ description: "Complete markdown spec file with required frontmatter" }),
		}),
		async execute(_toolCallId, params) {
			if (!/^\.sworm\/spec\/[a-z0-9][a-z0-9-]*\/.+\.md$/.test(params.path)) {
				throw new Error("Spec path must stay under .sworm/spec/<name>/ and end in .md");
			}
			const metadataRequired = params.path.endsWith("/todo.md") || params.path.endsWith("/SPEC.md");
			const result = saveFile(".sworm/spec", params.path, params.content, metadataRequired);
			return { content: [{ type: "text", text: `Saved ${result.path} (${result.bytes} bytes).` }], details: result };
		},
	});
}
