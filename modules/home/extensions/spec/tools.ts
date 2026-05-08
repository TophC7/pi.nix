import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { saveFile } from "./files.ts";

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
			if (!/^\.sworm\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/.test(params.path)) {
				throw new Error("Plan path must match .sworm/plans/YYYY-MM-DD-<slug>.md");
			}
			const result = saveFile(".sworm/plans", params.path, params.content, true);
			return { content: [{ type: "text", text: `Saved ${result.path} (${result.bytes} bytes).` }], details: result };
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
