import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import { checkActiveSpace } from "../../embed/state.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Searching the index.
 *
 * Retrieval itself is not written yet — keyword and hybrid search are their
 * own tickets. What is here is the guard that has to come first either way: a
 * query embedded by one model cannot be compared against vectors written by
 * another, and answering anyway would be worse than not answering, because
 * the results would look ordinary.
 */
export function runSearch(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const provider = selectProvider(context.env, context.report);
	const db = openDatabase(paths.database);
	try {
		const mismatch = checkActiveSpace(
			db,
			{ model: provider.model, dim: provider.dim },
			provider.source,
		);
		if (mismatch !== undefined) {
			return { code: 1, stderr: mismatch };
		}
	} finally {
		db.close();
	}

	return { code: 1, stderr: "search is not implemented yet." };
}
