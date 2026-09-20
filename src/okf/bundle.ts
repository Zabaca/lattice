/**
 * Walking an OKF bundle.
 *
 * A bundle is a directory of markdown files; a concept's identity is its
 * bundle-relative path. Two filenames are reserved by the specification —
 * `index.md` (a directory listing) and `log.md` (a change history) — and are
 * navigation rather than knowledge, so they are not concepts.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Filenames the OKF specification reserves at any directory level. */
export const RESERVED_FILENAMES: ReadonlySet<string> = new Set([
	"index.md",
	"log.md",
]);

export interface BundleFile {
	/** The bundle-relative path, with forward slashes: the concept's identity. */
	path: string;
	/** The absolute path on disk. */
	absolutePath: string;
	/** The bundle-relative directory, `""` at the bundle root. */
	directory: string;
	byteSize: number;
	mtimeMs: number;
}

/**
 * List every concept file in the bundle at `root`, sorted by path.
 *
 * Hidden entries are skipped, so an editor's dotfiles and a `.git` directory
 * inside the bundle never become concepts.
 */
export function listConceptFiles(root: string): BundleFile[] {
	const files: BundleFile[] = [];
	walk(root, "", files);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files;
}

function walk(root: string, relative: string, out: BundleFile[]): void {
	const absoluteDirectory = relative === "" ? root : join(root, relative);
	const entries = readdirSync(absoluteDirectory, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.name.startsWith(".")) {
			continue;
		}

		const childRelative =
			relative === "" ? entry.name : `${relative}/${entry.name}`;

		if (entry.isDirectory()) {
			walk(root, childRelative, out);
			continue;
		}

		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			continue;
		}
		if (RESERVED_FILENAMES.has(entry.name)) {
			continue;
		}

		const absolutePath = join(root, childRelative);
		const stats = statSync(absolutePath);
		out.push({
			path: childRelative,
			absolutePath,
			directory: relative,
			byteSize: stats.size,
			mtimeMs: Math.round(stats.mtimeMs),
		});
	}
}
