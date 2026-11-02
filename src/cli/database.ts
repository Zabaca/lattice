/**
 * The database every command reads: the note store.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { openStore } from "../store/open.js";
import type { LatticePaths } from "../utils/paths.js";

/** What is missing and what to run, or undefined when the store is there. */
export function storeProblem(paths: LatticePaths): string | undefined {
	return existsSync(paths.store)
		? undefined
		: `No note store at ${paths.store}. Run \`lattice init\` for an empty one, or \`lattice import\` to bring in notes.`;
}

/** Open the store, or throw what is missing and what to run. */
export function openNoteStore(paths: LatticePaths): Database {
	const problem = storeProblem(paths);
	if (problem !== undefined) {
		throw new Error(problem);
	}
	return openStore(paths.store);
}
