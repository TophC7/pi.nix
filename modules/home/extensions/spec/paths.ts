import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export function resolveInside(root: string, path: string): string {
	const fullRoot = resolve(root);
	const normalizedPath = normalize(path);
	const normalizedRoot = normalize(root);
	const rootPrefixed = normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
	const fullPath = resolve(rootPrefixed || isAbsolute(normalizedPath) ? normalizedPath : resolve(fullRoot, normalizedPath));
	const rel = relative(fullRoot, fullPath);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
		throw new Error(`Path outside allowed root: ${path}`);
	}
	return fullPath;
}
