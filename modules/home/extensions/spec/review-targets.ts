export type ReviewTarget =
	| { kind: "working-tree" }
	| { kind: "staged" }
	| { kind: "range"; base: string; head: string }
	| { kind: "branch"; name: string; base?: string }
	| { kind: "paths"; paths: string[] }
	| { kind: "paste"; content: string }
	| { kind: "freeform"; path: string };

export type ReviewTargetParseResult =
	| { ok: true; target: ReviewTarget }
	| { ok: false; error: string };

export const REVIEW_TARGET_USAGE = "working-tree | staged | range <base>..<head> | branch <name> [base] | paths <path...> | paste [text] | freeform <path>";

export function parseReviewTarget(input: string): ReviewTargetParseResult {
	const trimmed = input.trim();
	if (!trimmed) return fail("Missing target. Expected: " + REVIEW_TARGET_USAGE);
	const [command = "", ...rest] = trimmed.split(/\s+/);

	if (command === "working-tree") return noArgs(command, rest, { kind: "working-tree" });
	if (command === "staged") return noArgs(command, rest, { kind: "staged" });
	if (command === "range") return parseRange(rest);
	if (command === "branch") return parseBranch(rest);
	if (command === "paths") return parsePaths(rest);
	if (command === "paste") {
		const content = rest.join(" ");
		if (!content.trim()) return fail("Target 'paste' requires non-empty inline text or collected multiline content.");
		return { ok: true, target: { kind: "paste", content } };
	}
	if (command === "freeform") return parseFreeform(rest);

	return fail(`Unknown review target '${command}'. Expected: ${REVIEW_TARGET_USAGE}`);
}

export function formatReviewTarget(target: ReviewTarget): string {
	switch (target.kind) {
		case "working-tree":
		case "staged":
			return target.kind;
		case "range":
			return `range ${target.base}..${target.head}`;
		case "branch":
			return target.base ? `branch ${target.name} ${target.base}` : `branch ${target.name}`;
		case "paths":
			return `paths ${target.paths.join(" ")}`;
		case "paste":
			return "paste <inline>";
		case "freeform":
			return `freeform ${target.path}`;
	}
}

function noArgs(command: string, rest: string[], target: ReviewTarget): ReviewTargetParseResult {
	if (rest.length > 0) return fail(`Target '${command}' takes no extra arguments.`);
	return { ok: true, target };
}

function parseRange(rest: string[]): ReviewTargetParseResult {
	if (rest.length !== 1) return fail("Target 'range' expects exactly one argument: <base>..<head>.");
	const range = rest[0];
	if (!range) return fail("Target 'range' must use <base>..<head>.");
	const parts = range.split("..");
	const [base = "", head = ""] = parts;
	if (!base || !head || parts.length !== 2) return fail("Target 'range' must use <base>..<head>.");
	return { ok: true, target: { kind: "range", base, head } };
}

function parseBranch(rest: string[]): ReviewTargetParseResult {
	if (rest.length < 1 || rest.length > 2) return fail("Target 'branch' expects: branch <name> [base].");
	const [name, base] = rest;
	if (!name) return fail("Target 'branch' requires a branch name.");
	return { ok: true, target: base ? { kind: "branch", name, base } : { kind: "branch", name } };
}

function parsePaths(rest: string[]): ReviewTargetParseResult {
	if (rest.length === 0) return fail("Target 'paths' requires at least one path.");
	return { ok: true, target: { kind: "paths", paths: rest } };
}

function parseFreeform(rest: string[]): ReviewTargetParseResult {
	if (rest.length !== 1 || !rest[0]) return fail("Target 'freeform' expects exactly one context file path.");
	return { ok: true, target: { kind: "freeform", path: rest[0] } };
}

function fail(error: string): ReviewTargetParseResult {
	return { ok: false, error };
}
