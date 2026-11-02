/**
 * @fileoverview Path resolution for Lattice.
 *
 * All Lattice data lives under a single home directory:
 * - store.db     The note store: the only copy of the notes, their changes, and the search index derived from them
 * - backups/     Snapshots of store.db: one a day, the last 30; and `.remote-copy.json`, how the last copy off the machine went
 * - export/      The default home of `lattice export`, a copy never read back
 * - archive/     Notes kept outside the store (Lattice 1's library, Lattice 2's files); only `lattice import` reads them
 * - models/      Cached embedding model weights (`LATTICE_MODEL_DIR` moves it)
 * - docs/, lattice.db   Lattice 2's file bundle and its index: read by `lattice import` once, to bring them in
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
	/** Lattice 2's markdown bundle, which `lattice import` reads when it is there. */
	docs: string;
	/** Lattice 2's file index, whose vectors `lattice import` copies when it is there. */
	fileIndex: string;
	/** The note store: the notes themselves, their changes, and an index derived from them. */
	store: string;
	/** Snapshots of the note store: one a day, the last 30. */
	backups: string;
	/** How the last copy of a snapshot to another machine went, beside the snapshots. */
	remoteCopy: string;
	/** Where `lattice export` writes by default: a copy of the notes as markdown. */
	export: string;
	/** Folders of notes kept outside the store, such as `archive/v1` and `archive/v2`. */
	archive: string;
	/** Lattice 1's archived library: `docs/` and `lost/` under it. */
	library: string;
	/** The local configuration file. */
	env: string;
	/** Cached embedding model weights, one directory per hub repository. */
	models: string;
	/** The lock a running `lattice embed` holds. */
	embedLock: string;
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
		fileIndex: join(home, "lattice.db"),
		store: join(home, "store.db"),
		backups: join(home, "backups"),
		remoteCopy: join(home, "backups", ".remote-copy.json"),
		export: join(home, "export"),
		archive: join(home, "archive"),
		library: join(home, "archive", "v1"),
		env: join(home, ".env"),
		models: env.LATTICE_MODEL_DIR?.trim() || join(home, "models"),
		embedLock: join(home, ".embed.lock"),
	};
}

/** The file a copy of one snapshot to another machine holds while it runs, so no second one starts. */
export function remoteLockPath(backups: string, snapshot: string): string {
	return join(backups, `.remote-copy-${snapshot}.lock`);
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
