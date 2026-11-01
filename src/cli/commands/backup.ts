import { backupNow } from "../../store/backup.js";
import { resolvePaths } from "../../utils/paths.js";
import { openTarget } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice backup`: take a snapshot of the note store now, in the backups
 * folder, keeping the last 30. The server takes one itself on the first write
 * of each day; this is for before something risky, or for a scheduler to run.
 */
export function runBackup(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);
	const db = openTarget(paths, { store: true });
	try {
		const made = backupNow(db, paths.backups);
		return { code: 0, stdout: `Snapshot written: ${made.path}\n` };
	} finally {
		db.close();
	}
}
