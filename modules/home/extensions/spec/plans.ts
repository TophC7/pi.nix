import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { PlanDraft } from "./types.ts";
import { readFrontmatterValue } from "./files.ts";

export const PLAN_DRAFT_PATH_RE = /^\.sworm\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/;

export function isPlanDraftPath(path: string): boolean {
	return PLAN_DRAFT_PATH_RE.test(path);
}

export function parsePlanCommand(args: string | undefined): "help" | "exit" | "start" | "open" | "promote" {
	const trimmed = args?.trim() ?? "";
	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") return "help";
	if (trimmed === "exit" || trimmed === "cancel") return "exit";
	if (trimmed === "open") return "open";
	if (trimmed === "promote") return "promote";
	return "start";
}

export function listPlanDrafts(): PlanDraft[] {
	const dir = ".sworm/plans";
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => {
			const path = join(dir, name);
			const content = readFileSync(path, "utf8");
			return {
				path,
				title: readFrontmatterValue(content, "title") || basename(name, ".md"),
				status: readFrontmatterValue(content, "status") || "unknown",
				promotedTo: readFrontmatterValue(content, "promoted_to"),
			};
		});
}

export async function pickPlan(ctx: ExtensionCommandContext, title: string): Promise<PlanDraft | undefined> {
	const drafts = listPlanDrafts();
	if (drafts.length === 0) {
		ctx.ui.notify("No plan drafts found in .sworm/plans/.", "error");
		return undefined;
	}
	const choices = drafts.map((draft) => `${draft.title} [${draft.status}] · ${draft.path}${draft.promotedTo ? ` · promoted to ${draft.promotedTo}` : ""}`);
	const choice = await ctx.ui.select(title, choices);
	const index = choices.indexOf(choice ?? "");
	return index >= 0 ? drafts[index] : undefined;
}
