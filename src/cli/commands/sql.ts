import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Run a read-only query against the index and print the rows as JSON.
 *
 * `query_only` is what makes this safe: SQLite itself rejects any statement
 * that would write, so there is no pattern matching over SQL text to be
 * fooled by.
 */
export function runSql(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const db = openDatabase(paths.database);
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
