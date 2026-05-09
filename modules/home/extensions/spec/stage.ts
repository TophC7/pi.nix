import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeStageDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pi-${prefix}-`));
}

export function writeStage(dir: string, name: string, content: string): string {
	const path = join(dir, `${name}.md`);
	writeFileSync(path, content, "utf8");
	return path;
}
