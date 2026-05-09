import {
	REVIEW_SEVERITY_RANK,
	defaultPromotionNote,
	isReviewCardHeaderLine,
	parseReviewCardField,
	parseReviewCardHeader,
	renderReviewCardHeader,
	type ReviewScope,
	type ReviewSeverity,
} from "./review-schema.ts";
import { formatReviewTarget, type ReviewTarget } from "./review-targets.ts";

export interface SynthesizedReviewFinding {
	severity: ReviewSeverity;
	scope: ReviewScope;
	location: string;
	problem: string;
	evidence: string;
	fixDirection: string;
	specPromotionNote: string;
}

export interface QuarantinedReviewCard {
	rawHeader: string;
	reasons: string[];
}

export interface ReviewSynthesis {
	findings: SynthesizedReviewFinding[];
	quarantined: QuarantinedReviewCard[];
	report: string;
	planDraft: string;
}

export function synthesizeReview(rawFindings: string, target: ReviewTarget): ReviewSynthesis {
	const parsed = parseReviewCards(rawFindings);
	const findings = dedupeFindings(parsed.findings).sort(compareFindings);
	return {
		findings,
		quarantined: parsed.quarantined,
		report: renderReport(findings, parsed.quarantined, target),
		planDraft: renderPlanDraft(findings, target),
	};
}

interface ParseResult {
	findings: SynthesizedReviewFinding[];
	quarantined: QuarantinedReviewCard[];
}

function parseReviewCards(raw: string): ParseResult {
	const lines = raw.split("\n");
	const findings: SynthesizedReviewFinding[] = [];
	const quarantined: QuarantinedReviewCard[] = [];
	for (let index = 0; index < lines.length; index++) {
		const headerLine = lines[index] ?? "";
		if (!isReviewCardHeaderLine(headerLine)) continue;
		const parsedHeader = parseReviewCardHeader(headerLine);
		if (!parsedHeader.ok) {
			quarantined.push({ rawHeader: headerLine.trim(), reasons: parsedHeader.errors });
			continue;
		}
		const { severity, scope, location } = parsedHeader.header;
		const fields: Partial<Record<"problem" | "evidence" | "fixDirection" | "specPromotionNote", string>> = {};
		for (index++; index < lines.length; index++) {
			const line = lines[index] ?? "";
			if (isReviewCardHeaderLine(line)) {
				index--;
				break;
			}
			const field = parseReviewCardField(line);
			if (field) fields[field.key] = field.value;
		}
		const missing = missingRequiredFields(fields);
		if (missing.length > 0) {
			quarantined.push({
				rawHeader: headerLine.trim(),
				reasons: missing.map((field) => `missing ${field}`),
			});
			continue;
		}
		findings.push({
			severity,
			scope,
			location,
			problem: fields.problem!,
			evidence: fields.evidence!,
			fixDirection: fields.fixDirection!,
			specPromotionNote: fields.specPromotionNote || defaultPromotionNote(severity),
		});
	}
	return { findings, quarantined };
}

function missingRequiredFields(fields: Partial<Record<"problem" | "evidence" | "fixDirection" | "specPromotionNote", string>>): string[] {
	const missing: string[] = [];
	if (!fields.problem) missing.push("Problem");
	if (!fields.evidence) missing.push("Evidence");
	if (!fields.fixDirection) missing.push("Fix direction");
	return missing;
}

function dedupeFindings(findings: SynthesizedReviewFinding[]): SynthesizedReviewFinding[] {
	const byIdentity = new Map<string, SynthesizedReviewFinding>();
	for (const finding of findings) {
		const key = findingIdentity(finding);
		const existing = byIdentity.get(key);
		if (!existing) {
			byIdentity.set(key, finding);
			continue;
		}
		byIdentity.set(key, {
			...existing,
			evidence: mergeText(existing.evidence, finding.evidence, " ; "),
			fixDirection: mergeText(existing.fixDirection, finding.fixDirection, " ; "),
			specPromotionNote: mergeText(existing.specPromotionNote, finding.specPromotionNote, " ; "),
		});
	}
	return [...byIdentity.values()];
}

function findingIdentity(finding: SynthesizedReviewFinding): string {
	return [finding.severity, finding.scope, finding.location, normalizeIdentityText(finding.problem)].join("\0").toLowerCase();
}

function normalizeIdentityText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function compareFindings(a: SynthesizedReviewFinding, b: SynthesizedReviewFinding): number {
	return REVIEW_SEVERITY_RANK[a.severity] - REVIEW_SEVERITY_RANK[b.severity] || a.location.localeCompare(b.location);
}

function renderReport(findings: SynthesizedReviewFinding[], quarantined: QuarantinedReviewCard[], target: ReviewTarget): string {
	const verdict = findings.some((finding) => finding.severity === "Blocking" || finding.severity === "Required") ? "Request Changes" : "Approve";
	return [
		"# /plan:review report",
		"",
		"## Summary",
		`Adversarial review target: ${formatReviewTarget(target)}. Findings are deduplicated by severity, scope, location, and problem, then sorted Blocking, Required, Suggestion.`,
		"",
		"## Findings",
		findings.length ? renderCards(findings) : "No findings.",
		"",
		"## Quarantined cards",
		quarantined.length ? renderQuarantined(quarantined) : "None.",
		"",
		"## Open Questions / Assumptions",
		"- Review agents may have used bounded/truncated context; verify truncation notes before promotion.",
		quarantined.length ? `- ${quarantined.length} malformed card(s) quarantined; rerun the affected agents or repair the schema before promotion.` : "",
		"",
		"## Verdict",
		verdict,
		"",
	].filter((line) => line !== "").join("\n");
}

function renderQuarantined(quarantined: QuarantinedReviewCard[]): string {
	return quarantined.map((card, index) => `- #${index + 1} ${card.rawHeader || "<missing header>"} — ${card.reasons.join("; ")}`).join("\n");
}

function renderPlanDraft(findings: SynthesizedReviewFinding[], target: ReviewTarget): string {
	const required = findings.filter((finding) => finding.severity === "Blocking" || finding.severity === "Required");
	const suggestions = findings.filter((finding) => finding.severity === "Suggestion");
	return [
		"---",
		`title: Review plan for ${formatReviewTarget(target)}`,
		`created: ${new Date().toISOString().slice(0, 10)}`,
		"status: draft",
		"review_plan: true",
		"hardened_by:",
		"hardened_status:",
		"hardened_at:",
		"waiver_reason:",
		"---",
		"",
		"## Goal",
		`Address adversarial review findings for ${formatReviewTarget(target)} before promotion to durable spec work.`,
		"",
		"## Review findings",
		findings.length ? renderCards(findings) : "No findings.",
		"",
		"## Required work",
		required.length ? required.map((finding) => `- ${finding.severity}: ${finding.location} — ${finding.problem} Fix: ${finding.fixDirection}`).join("\n") : "No Blocking or Required findings.",
		"",
		"## Suggestions",
		suggestions.length ? suggestions.map((finding) => `- ${finding.location} — ${finding.problem} Fix: ${finding.fixDirection}`).join("\n") : "No Suggestions.",
		"",
		"## Promotion notes",
		"- Blocking and Required findings should become §T work during `/spec:new` promotion.",
		"- Suggestions stay advisory unless explicit opt-in metadata promotes them.",
		"- Do not save this draft until AskClaude hardening passes or a waiver is recorded.",
		"",
	].join("\n");
}

function renderCards(findings: SynthesizedReviewFinding[]): string {
	return findings.map((finding, index) => [
		renderReviewCardHeader(index + 1, finding),
		`Problem: ${finding.problem}`,
		`Evidence: ${finding.evidence}`,
		`Fix direction: ${finding.fixDirection}`,
		`Spec promotion note: ${finding.specPromotionNote}`,
	].join("\n")).join("\n\n");
}

function mergeText(a: string, b: string, separator = ", "): string {
	if (!b || a === b || a.includes(b)) return a;
	if (!a) return b;
	return `${a}${separator}${b}`;
}
