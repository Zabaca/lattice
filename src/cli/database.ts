/**
 * Which database a command reads: the file index, or with `--store` the note
 * store. Until the cutover both exist, and the file index stays the default.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { openDatabase } from "../db/open.js";
import { openStore } from "../store/open.js";
import type { LatticePaths } from "../utils/paths.js";

type Flags = Record<string, string | true>;

/** What is missing and what to run, or undefined when the database is there. */
export function targetProblem(
	paths: LatticePaths,
	flags: Flags,
): string | undefined {
	if (flags.store !== undefined) {
		return existsSync(paths.store)
			? undefined
			: `No note store at ${paths.store}. Run \`lattice import\` first.`;
	}
	return existsSync(paths.database)
		? undefined
		: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`;
}

/** Open the database the flags name, or throw what is missing and what to run. */
export function openTarget(paths: LatticePaths, flags: Flags): Database {
	const problem = targetProblem(paths, flags);
	if (problem !== undefined) {
		throw new Error(problem);
	}
	return flags.store !== undefined
		? openStore(paths.store)
		: openDatabase(paths.database);
}
