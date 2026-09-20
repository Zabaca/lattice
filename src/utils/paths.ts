/**
 * @fileoverview Path resolution for Lattice.
 *
 * All Lattice data lives under a single home directory:
 * - docs/        Markdown documentation
 * - lattice.db   SQLite index (concepts, chunks, links, embeddings)
 * - .env         Local configuration
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
	/** The local configuration file. */
	env: string;
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
		env: join(home, ".env"),
		syncLock: join(home, ".sync.lock"),
	};
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
