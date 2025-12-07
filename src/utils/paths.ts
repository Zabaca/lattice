/**
 * @fileoverview Centralized path utilities for Lattice
 *
 * All Lattice data is stored in ~/.lattice/:
 * - docs/               Markdown documentation
 * - lattice.duckdb      Graph database
 * - .sync-manifest.json Sync state tracking
 * - .env                API keys (VOYAGE_API_KEY)
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Default home directory, can be overridden for testing
let latticeHomeOverride: string | null = null;

/**
 * Override the lattice home path (for testing only)
 */
export function setLatticeHomeForTesting(path: string | null): void {
	latticeHomeOverride = path;
}

/**
 * Get the current lattice home path
 */
function getLatticeHomeInternal(): string {
	if (latticeHomeOverride) {
		return latticeHomeOverride;
	}
	return join(homedir(), ".lattice");
}

/**
 * Get the root Lattice directory path (~/.lattice)
 */
export function getLatticeHome(): string {
	return getLatticeHomeInternal();
}

/**
 * Get the docs directory path (~/.lattice/docs)
 */
export function getDocsPath(): string {
	return join(getLatticeHomeInternal(), "docs");
}

/**
 * Get the DuckDB database path (~/.lattice/lattice.duckdb)
 */
export function getDatabasePath(): string {
	return join(getLatticeHomeInternal(), "lattice.duckdb");
}

/**
 * Get the sync manifest path (~/.lattice/.sync-manifest.json)
 */
export function getManifestPath(): string {
	return join(getLatticeHomeInternal(), ".sync-manifest.json");
}

/**
 * Get the environment file path (~/.lattice/.env)
 */
export function getEnvPath(): string {
	return join(getLatticeHomeInternal(), ".env");
}

/**
 * Ensure the Lattice home directory and docs subdirectory exist
 */
export function ensureLatticeHome(): void {
	const home = getLatticeHomeInternal();
	if (!existsSync(home)) {
		mkdirSync(home, { recursive: true });
	}
	const docsPath = getDocsPath();
	if (!existsSync(docsPath)) {
		mkdirSync(docsPath, { recursive: true });
	}
}
