import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Statements that only read. Anything else needs `--write`, so that a hand
 * query cannot desynchronise the index by accident.
 */
const READ_ONLY_PREFIXES = ["select", "with", "pragma", "explain"];

function isReadOnly(sql: string): boolean {
	const trimmed = sql.trim();

	// One statement only. `SELECT 1; DELETE FROM concepts` opens with a read
	// and would slip past a check that only looks at the leading keyword.
	const semicolon = trimmed.indexOf(";");
	if (semicolon !== -1 && trimmed.slice(semicolon + 1).trim() !== "") {
		return false;
	}

	const firstWord = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	return READ_ONLY_PREFIXES.includes(firstWord);
}

/**
 * Run one SQL statement against the index and print the rows as JSON.
 *
 * Read-only by default: the index is derived state, and a write through this
 * command can put it out of step with the documents it came from.
 */
export function runSql(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const sql = context.positionals.join(" ");
	if (!isReadOnly(sql) && context.flags.write !== true) {
		return {
			code: 1,
			stderr:
				"Refusing to run a statement that is not a read. Pass --write to run it anyway.",
		};
	}

	const db = openDatabase(paths.database);
	try {
		const rows = db.query(sql).all();
		return { code: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` };
	} finally {
		db.close();
	}
}
