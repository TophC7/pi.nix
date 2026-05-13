import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BurdenRowView, BurdenSnapshotView } from "./view-model.ts";

export type BurdenOpenKind = "source" | "snapshot" | "unavailable";

export interface BurdenOpenResult {
	readonly ok: boolean;
	readonly kind: BurdenOpenKind;
	readonly status: string;
	readonly path?: string;
}

export interface BurdenOpenOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => Date;
	readonly onStatus?: (status: string) => void;
	readonly requestRender?: () => void;
}

let snapshotDir: string | undefined;
let snapshotCounter = 0;

export function openBurdenSource(row: BurdenRowView, options: BurdenOpenOptions = {}): BurdenOpenResult {
	const sourcePath = row.actions.openSource?.path;
	if (!sourcePath) return unavailable(`No source path for ${row.label}.`);
	return openPath(sourcePath, "source", options);
}

export function openBurdenSnapshot(row: BurdenRowView, options: BurdenOpenOptions = {}): BurdenOpenResult {
	const snapshot = row.actions.openSnapshot;
	if (!snapshot) return unavailable(`No generated content for ${row.label}.`);
	const snapshotPath = writeSnapshot(snapshot, options.now?.() ?? new Date());
	return openPath(snapshotPath, "snapshot", options);
}

export function snapshotDirectory(): string {
	if (!snapshotDir) snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-burden-"));
	return snapshotDir;
}

function openPath(filePath: string, kind: Exclude<BurdenOpenKind, "unavailable">, options: BurdenOpenOptions): BurdenOpenResult {
	const visual = resolveVisual(options.env ?? process.env);
	if (!visual.ok) return { ok: false, kind, status: visual.status, path: filePath };

	try {
		const child = spawn(visual.command, [filePath], { detached: true, stdio: "ignore" });
		child.on("error", (error) => {
			options.onStatus?.(`Failed to open ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
			options.requestRender?.();
		});
		child.unref();
		return { ok: true, kind, status: `Opening ${filePath}`, path: filePath };
	} catch (error) {
		return {
			ok: false,
			kind,
			status: `Failed to open ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			path: filePath,
		};
	}
}

function resolveVisual(env: NodeJS.ProcessEnv): { ok: true; command: string } | { ok: false; status: string } {
	const visual = env.VISUAL?.trim();
	if (!visual) return { ok: false, status: "$VISUAL is not set; no $EDITOR fallback is used." };
	if (/\s/.test(visual)) return { ok: false, status: "$VISUAL must be an executable path/name only; arguments and whitespace are not supported." };
	return { ok: true, command: visual };
}

function writeSnapshot(snapshot: BurdenSnapshotView, now: Date): string {
	const dir = snapshotDirectory();
	const filename = `${String(++snapshotCounter).padStart(3, "0")}-${safeFilename(snapshot.suggestedName)}`;
	const filePath = path.join(dir, filename);
	fs.writeFileSync(filePath, snapshotText(snapshot, now), "utf8");
	return filePath;
}

function snapshotText(snapshot: BurdenSnapshotView, now: Date): string {
	const metadata = snapshot.metadata;
	return [
		"--- pi-burden snapshot ---",
		`timestamp: ${now.toISOString()}`,
		`row_id: ${metadata.rowId}`,
		`entry_id: ${metadata.entryId}`,
		`label: ${metadata.label}`,
		`source: ${metadata.sourceLabel}`,
		`tokens: ${metadata.tokens}`,
		`chars: ${metadata.chars}`,
		"--- content ---",
		"",
		snapshot.content,
	].join("\n");
}

function safeFilename(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "snapshot.md";
}

function unavailable(status: string): BurdenOpenResult {
	return { ok: false, kind: "unavailable", status };
}
