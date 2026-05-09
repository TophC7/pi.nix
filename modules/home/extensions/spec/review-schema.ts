export const REVIEW_SEVERITIES = ["Blocking", "Required", "Suggestion"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_SCOPES = [
	"Architecture Fit",
	"Primitive & Pattern Reuse",
	"Idiom Compliance",
	"Quality",
	"Efficiency",
	"Comment Style",
] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

export const REVIEW_AGENT_REGISTRY = [
	{ agent: "spec.review-architecture", scope: "Architecture Fit" },
	{ agent: "spec.review-reuse", scope: "Primitive & Pattern Reuse" },
	{ agent: "spec.review-idiom", scope: "Idiom Compliance" },
	{ agent: "spec.review-quality", scope: "Quality" },
	{ agent: "spec.review-efficiency", scope: "Efficiency" },
	{ agent: "spec.review-comment", scope: "Comment Style" },
] as const;

export const REVIEW_SEVERITY_RANK: Record<ReviewSeverity, number> = {
	Blocking: 0,
	Required: 1,
	Suggestion: 2,
};

export const REVIEW_CARD_FIELD_TO_KEY = {
	Problem: "problem",
	Evidence: "evidence",
	"Fix direction": "fixDirection",
	"Spec promotion note": "specPromotionNote",
} as const;
export const REVIEW_CARD_FIELD_LABELS = Object.keys(REVIEW_CARD_FIELD_TO_KEY) as ReviewCardFieldLabel[];
export type ReviewCardFieldLabel = keyof typeof REVIEW_CARD_FIELD_TO_KEY;
export type ReviewCardFieldKey = (typeof REVIEW_CARD_FIELD_TO_KEY)[ReviewCardFieldLabel];

export interface ReviewCardHeader {
	index: number;
	severity: ReviewSeverity;
	scope: ReviewScope;
	location: string;
}

export type ReviewCardHeaderParseResult =
	| { ok: true; header: ReviewCardHeader }
	| { ok: false; errors: string[] };

export interface ReviewCardField {
	label: ReviewCardFieldLabel;
	key: ReviewCardFieldKey;
	value: string;
}

export interface ReviewCard {
	severity: ReviewSeverity;
	scope: ReviewScope;
	location: string;
	problem: string;
	evidence: string;
	fixDirection: string;
	specPromotionNote: string;
}

export interface ReviewCardValidationResult {
	valid: boolean;
	errors: string[];
	card?: ReviewCard;
}

const CARD_HEADER_RE = /^──\s*#(\d+)\s*·\s*([^·]+?)\s*·\s*([^·]+?)\s*·\s*(.+?)\s*─+\s*$/;
const CARD_FIELD_RE = /^([^:]+):\s*(.*)$/;

export const REVIEW_CARD_SCHEMA_PROMPT = `Review findings must use this card schema exactly. Markdown pipe tables are forbidden.

Required fields per card:
- Severity: ${REVIEW_SEVERITIES.join(" | ")}
- Scope: ${REVIEW_SCOPES.join(" | ")}
- Location: code-formatted path:line, path:start-end, multiple comma-separated sites, or \`unknown\` only when no file/line is knowable
- Problem: concrete failure mode, one or two sentences
- Evidence: specific observed code/context proving the problem
- Fix direction: imperative, specific repair direction
- Spec promotion note: "Promote" for Blocking/Required work, "Advisory" for Suggestions unless explicit opt-in metadata says otherwise

Format:
── #<n> · <Severity> · <Scope> · <Location> ─────────────────
Problem: <failure mode>
Evidence: <specific evidence>
Fix direction: <specific repair>
Spec promotion note: <Promote | Advisory | opt-in rationale>

No findings: write exactly \`No findings.\`.`;

export function isReviewSeverity(value: unknown): value is ReviewSeverity {
	return typeof value === "string" && REVIEW_SEVERITIES.includes(value as ReviewSeverity);
}

export function isReviewScope(value: unknown): value is ReviewScope {
	return typeof value === "string" && REVIEW_SCOPES.includes(value as ReviewScope);
}

export function normalizeReviewSeverity(value: string): ReviewSeverity | undefined {
	const normalized = value.trim().toLowerCase();
	return REVIEW_SEVERITIES.find((severity) => severity.toLowerCase() === normalized);
}

export function isReviewCardHeaderLine(line: string): boolean {
	return line.startsWith("── #");
}

export function parseReviewCardHeader(line: string): ReviewCardHeaderParseResult {
	const match = line.match(CARD_HEADER_RE);
	if (!match) return { ok: false, errors: [`Malformed review card header: ${line}`] };
	const errors: string[] = [];
	const severityText = match[2]?.trim() ?? "";
	const scopeText = match[3]?.trim() ?? "";
	const location = cleanReviewLocation(match[4] ?? "");
	const severity = normalizeReviewSeverity(severityText);
	if (!severity) errors.push(`Invalid review severity: ${severityText}`);
	if (!isReviewScope(scopeText)) errors.push(`Invalid review scope: ${scopeText}`);
	if (!location) errors.push(`Review card missing location: ${line}`);
	if (errors.length > 0 || !severity || !isReviewScope(scopeText)) return { ok: false, errors };
	return { ok: true, header: { index: Number(match[1] ?? "0"), severity, scope: scopeText, location } };
}

export function renderReviewCardHeader(index: number, card: Pick<ReviewCard, "severity" | "scope" | "location">): string {
	return `── #${index} · ${card.severity} · ${card.scope} · ${card.location} ─────────────────`;
}

export function parseReviewCardField(line: string): ReviewCardField | undefined {
	const match = line.match(CARD_FIELD_RE);
	const label = match?.[1]?.trim();
	if (!label || !isReviewCardFieldLabel(label)) return undefined;
	return { label, key: REVIEW_CARD_FIELD_TO_KEY[label], value: match?.[2]?.trim() ?? "" };
}

export function isReviewCardFieldLabel(value: string): value is ReviewCardFieldLabel {
	return Object.hasOwn(REVIEW_CARD_FIELD_TO_KEY, value);
}

export function cleanReviewLocation(value: string): string {
	return value.trim().replace(/^`|`$/g, "") || "unknown";
}

export function defaultPromotionNote(severity: ReviewSeverity): string {
	return severity === "Suggestion" ? "Advisory" : "Promote";
}

export function validateReviewCard(input: Partial<Record<keyof ReviewCard, unknown>>): ReviewCardValidationResult {
	const errors: string[] = [];
	const severity = typeof input.severity === "string" ? normalizeReviewSeverity(input.severity) : undefined;
	if (!severity) errors.push(`severity must be one of: ${REVIEW_SEVERITIES.join(", ")}`);
	const scope = input.scope;
	if (!isReviewScope(scope)) errors.push(`scope must be one of: ${REVIEW_SCOPES.join(", ")}`);
	const location = requiredText(input.location, "location", errors);
	const problem = requiredText(input.problem, "problem", errors);
	const evidence = requiredText(input.evidence, "evidence", errors);
	const fixDirection = requiredText(input.fixDirection, "fixDirection", errors);
	const specPromotionNote = requiredText(input.specPromotionNote, "specPromotionNote", errors);

	if (errors.length > 0 || !severity || !isReviewScope(scope)) return { valid: false, errors };
	return {
		valid: true,
		errors: [],
		card: {
			severity,
			scope,
			location,
			problem,
			evidence,
			fixDirection,
			specPromotionNote,
		},
	};
}

function requiredText(value: unknown, field: string, errors: string[]): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		errors.push(`${field} is required`);
		return "";
	}
	return value.trim();
}
