/**
 * @fileoverview Path resolution for Lattice.
 *
 * All Lattice data lives under a single home directory:
 * - docs/        Markdown documentation
 * - lattice.db   SQLite index (concepts, chunks, links, embeddings)
 * - store.db     The note store (notes, sections, changes, and the same index tables)
 * - backups/     Snapshots of store.db: one a day, the last 30
 * - archive/     What `lattice import` may be asked to read; nothing watches it
 * - models/      Cached embedding model weights (`LATTICE_MODEL_DIR` moves it)
 * - .env         Reserved for local configuration; nothing reads it yet
 *
 * The home directory is resolved from an explicit environment rather than a
 * module-global, so the CLI seam can be driven against a temporary directory
 * without leaking into the real `~/.lattice`.
 */

import { join } from "node:path";

export interface LatticePaths {
	/** The Lattice home directory. */
	home: string;
	/** The markdown documentation directory. */
	docs: string;
	/** The SQLite index. */
	database: string;
	/** The note store: the notes themselves, their changes, and an index derived from them. */
	store: string;
	/** Snapshots of the note store: one a day, the last 30. */
	backups: string;
	/** Folders of notes kept outside the bundle, such as `archive/v1`. */
	archive: string;
	/** Lattice 1's archived library: `docs/` and `lost/` under it. */
	library: string;
	/** The local configuration file. */
	env: string;
	/** Cached embedding model weights, one directory per hub repository. */
	models: string;
	/** The lock a running sync holds. */
	syncLock: string;
}

/**
 * Resolve Lattice's paths from an environment.
 *
 * `LATTICE_HOME` wins; otherwise the home directory is `.lattice` under the
 * user's home. Throws when neither is available, rather than writing to a
 * path built from `undefined`.
 */
export function resolvePaths(
	env: Record<string, string | undefined>,
): LatticePaths {
	const home = resolveHome(env);
	return {
		home,
		docs: join(home, "docs"),
		database: join(home, "lattice.db"),
		store: join(home, "store.db"),
		backups: join(home, "backups"),
		archive: join(home, "archive"),
		library: join(home, "archive", "v1"),
		env: join(home, ".env"),
		models: env.LATTICE_MODEL_DIR?.trim() || join(home, "models"),
		syncLock: join(home, ".sync.lock"),
	};
}

/**
 * A path beside `path` that only this process uses, for a file built before it
 * is moved into place. Two imports running at once never share one.
 */
export function workPath(path: string, label: string): string {
	return `${path}.${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveHome(env: Record<string, string | undefined>): string {
	const explicit = env.LATTICE_HOME?.trim();
	if (explicit) {
		return explicit;
	}

	const userHome = env.HOME?.trim() || env.USERPROFILE?.trim();
	if (userHome) {
		return join(userHome, ".lattice");
	}

	throw new Error(
		"Cannot determine the Lattice home directory: set LATTICE_HOME or HOME.",
	);
}
