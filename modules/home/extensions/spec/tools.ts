import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { deferToAgentEnd, fireAndForgetHandoffReason, handoff } from "@pi/lib/handoff";
import { beginApprovedSpecFinalization, endApprovedSpecFinalization } from "@pi/lib/workflow";
import { saveFile } from "./files.ts";
import { requireSwormBridge } from "./issues.ts";
import { runSpecNew } from "./commands.ts";
import { exitMode } from "./mode.ts";
import { isPlanDraftPath } from "./plans.ts";
import { validateReviewPlanDraft } from "./review-plan-validator.ts";

function asCommandContext(ctx: ExtensionContext): ExtensionCommandContext {
	return {
		...ctx,
		waitForIdle: async () => undefined,
	} as ExtensionCommandContext;
}

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
			const outcome = await handoff({
				pi,
				ctx,
				label: "promote_plan",
				command: `/spec:new ${params.path}`,
				helper: async () => deferToAgentEnd(pi, (nextCtx) => runSpecNew(pi, asCommandContext(nextCtx), params.path)),
				policy: "confirm",
				reason: fireAndForgetHandoffReason(),
			});
			const text = `promote_plan handoff ${outcome.kind} for ${params.path}.`;
			return { content: [{ type: "text", text }], details: { path: params.path, outcome } };
		},
	});

	pi.registerTool({
		name: "approve_spec_finalization",
		label: "Approve Spec Finalization",
		description: "Open the finalization gate for /spec:new after explicit final user approval. Enables only sanctioned save tools and Sworm mutator/config tools until agent_end.",
		parameters: Type.Object({
			approval: Type.String({ description: "Short record of the user's explicit final approval, e.g. 'User approved final spec and Sworm writes.'" }),
		}),
		async execute(_toolCallId, params) {
			const approval = beginApprovedSpecFinalization(pi, params.approval);
			await deferToAgentEnd(pi, () => endApprovedSpecFinalization(pi, approval.lease.token, "agent_end"));
			const text = `Spec finalization approved; gate ${approval.lease.token} active until agent_end.`;
			return { content: [{ type: "text", text }], details: approval };
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
