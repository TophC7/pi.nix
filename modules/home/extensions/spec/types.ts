export const MODES = ["idle", "plan-authoring", "spec-authoring", "spec-working", "plan-review-authoring"] as const;

export type Mode = (typeof MODES)[number];

export interface ModeState {
	mode: Mode;
	snapshot?: string[];
}

export interface SaveResult {
	path: string;
	bytes: number;
}

export interface PlanDraft {
	path: string;
	title: string;
	status: string;
	promotedTo: string;
}

export interface SpecInfo {
	name: string;
	path: string;
	indexPath: string;
	shape: "light" | "phased" | "ticketed";
	title: string;
	swormEpicId?: string;
}

export interface TaskSummary {
	counts: Record<string, number>;
	readyLine: string;
	blockers: string[];
	manualChecks: string[];
}
