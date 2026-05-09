import { classifyHardeningMetadata } from "./review-hardening.ts";
import { REVIEW_CARD_FIELD_LABELS, isReviewCardHeaderLine, parseReviewCardField, parseReviewCardHeader } from "./review-schema.ts";

export interface ReviewPlanValidationOptions {
	requireHardening?: boolean;
}

export interface ReviewPlanValidationResult {
	valid: boolean;
	errors: string[];
}

const REQUIRED_SECTIONS = ["Goal", "Review findings", "Required work", "Suggestions", "Promotion notes"] as const;
export function isReviewPlanDraft(content: string): boolean {
	return /^---\n[\s\S]*?^review_plan:\s*true\s*$/m.test(content);
}

export function validateReviewPlanDraft(content: string, options: ReviewPlanValidationOptions = {}): ReviewPlanValidationResult {
	if (!isReviewPlanDraft(content)) return { valid: true, errors: [] };
	const errors: string[] = [];
	validateHardening(content, options, errors);
	validateSections(content, errors);
	validateCards(content, errors);
	return { valid: errors.length === 0, errors };
}

function validateHardening(content: string, options: ReviewPlanValidationOptions, errors: string[]): void {
	if (options.requireHardening === false) return;
	const result = classifyHardeningMetadata(content);
	if (result.status === "missing") errors.push(...result.errors);
}

function validateSections(content: string, errors: string[]): void {
	for (const section of REQUIRED_SECTIONS) {
		if (!new RegExp(`^## ${escapeRegExp(section)}\\s*$`, "m").test(content)) errors.push(`Missing required review-plan section: ${section}`);
	}
}

function validateCards(content: string, errors: string[]): void {
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const header = lines[index] ?? "";
		if (!header.startsWith("── #")) continue;
		const parsedHeader = parseReviewCardHeader(header);
		if (!parsedHeader.ok) {
			errors.push(...parsedHeader.errors);
			continue;
		}
		const { severity } = parsedHeader.header;
		const fields = cardFields(lines, index + 1);
		for (const field of REVIEW_CARD_FIELD_LABELS) {
			if (!fields[field]) errors.push(`Review card ${header} missing field: ${field}`);
		}
		const promotionNote = fields["Spec promotion note"] ?? "";
		if (severity === "Suggestion" && !/advisory|opt-?in/i.test(promotionNote)) {
			errors.push(`Suggestion card ${header} must be Advisory or include explicit opt-in metadata.`);
		}
	}
}

function cardFields(lines: string[], start: number): Record<string, string> {
	const fields: Record<string, string> = {};
	for (let index = start; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (isReviewCardHeaderLine(line)) break;
		const field = parseReviewCardField(line);
		if (field) fields[field.label] = field.value;
	}
	return fields;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
