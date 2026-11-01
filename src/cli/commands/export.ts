import { join } from "node:path";
import { exportStore } from "../../store/export.js";
import { resolvePaths } from "../../utils/paths.js";
import { openTarget } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice export [dir]`: write every note as a markdown file under its type's
 * folder. The export is a copy, marked as one, and nothing reads it back; the
 * folder defaults to `export` under the Lattice home.
 */
export function runExport(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);
	const db = openTarget(paths, { store: true });
	try {
		const dir = context.positionals[0] ?? join(paths.home, "export");
		const done = exportStore(db, dir);
		return {
			code: 0,
			stdout: `Exported ${done.notes} notes to ${done.dir} (${done.bytes} bytes). It is a copy: Lattice never reads it back.\n`,
		};
	} finally {
		db.close();
	}
}
