import { resolvePaths } from "../../utils/paths.js";
import { openNoteStore } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Run a read-only query against the note store and print the rows as JSON.
 *
 * `query_only` is what makes this safe: SQLite itself rejects any statement
 * that would write, so there is no pattern matching over SQL text to be
 * fooled by. It matters because the store's only writers are the store
 * module's operations, which is what keeps every change in the history.
 */
export function runSql(context: CommandContext): CommandOutput {
	const db = openNoteStore(resolvePaths(context.env));
	try {
		db.exec("PRAGMA query_only = ON");
		let rows: unknown[];
		try {
			rows = db.query(context.positionals[0]).all();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// SQLite says "readonly database"; say which of our rules that was.
			return {
				code: 1,
				stderr: message.includes("readonly")
					? `lattice sql is read-only and refused this statement: ${message}`
					: message,
			};
		}
		return { code: 0, stdout: `${JSON.stringify(rows)}\n` };
	} finally {
		db.close();
	}
}
