import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import { assertModelMatches } from "../../embed/run.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Search the index.
 *
 * Retrieval itself is not implemented yet. What is implemented is the guard
 * in front of it: a query embedded with one model cannot be compared to
 * vectors written by another, so a mismatched index is refused rather than
 * searched. That refusal has to exist before results do, because results from
 * a mixed index look perfectly plausible.
 */
export function runSearch(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const provider = selectProvider(context.env);
	const db = openDatabase(paths.database);
	try {
		assertModelMatches(db, provider);
	} finally {
		db.close();
	}

	return { code: 1, stderr: "search is not implemented yet." };
}
