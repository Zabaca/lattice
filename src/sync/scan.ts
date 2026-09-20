/**
 * Walking an OKF bundle.
 *
 * The two reserved OKF filenames are navigation, not knowledge, so they are
 * never concepts: directory membership already carries what an index would
 * add, and the log is a changelog.
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";

/** OKF v0.2 reserves these two filenames in every directory. */
export const RESERVED_FILENAMES = ["index.md", "log.md"];

export interface BundleFile {
	/** Bundle-relative path with forward slashes — the concept's identity. */
	path: string;
	/** Absolute path on disk. */
	absolutePath: string;
	contentHash: string;
	byteSize: number;
	mtimeMs: number;
}

/**
 * Every indexable markdown file in the bundle, sorted by path so a run is
 * deterministic.
 */
export function scanBundle(root: string): BundleFile[] {
	const files: BundleFile[] = [];
	collect(root, "", files);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files;
}

function collect(root: string, relative: string, into: BundleFile[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, relative), { withFileTypes: true });
	} catch {
		// A bundle directory that does not exist is an empty bundle, not a crash.
		return;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".")) {
			continue;
		}
		const childRelative = relative
			? posix.join(relative, entry.name)
			: entry.name;

		if (entry.isDirectory()) {
			collect(root, childRelative, into);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			continue;
		}
		if (RESERVED_FILENAMES.includes(entry.name)) {
			continue;
		}

		const absolutePath = join(root, childRelative.split("/").join(sep));
		const contents = readFileSync(absolutePath);
		into.push({
			path: childRelative,
			absolutePath,
			contentHash: hashContent(contents),
			byteSize: contents.byteLength,
			mtimeMs: Math.round(statSync(absolutePath).mtimeMs),
		});
	}
}

export function hashContent(contents: Buffer | string): string {
	return createHash("sha256").update(contents).digest("hex");
}
