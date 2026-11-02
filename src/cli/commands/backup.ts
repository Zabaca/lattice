import { backupNow } from "../../store/backup.js";
import {
	copySnapshot,
	describeRemote,
	REMOTE_ENV,
	remoteFrom,
} from "../../store/remote.js";
import { resolvePaths } from "../../utils/paths.js";
import { openNoteStore } from "../database.js";
import { text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice backup`: take a snapshot of the note store now, in the backups
 * folder, keeping the last 30. The server takes one itself on the first write
 * of each day; this is for before something risky.
 *
 * When `LATTICE_BACKUP_REMOTE` names a place, or `--remote user@host:folder`
 * does, the new snapshot is also copied there over ssh, the way the server
 * copies the day's. The snapshot is kept either way; a copy that fails exits 1
 * and says why. `--remote` with no place anywhere is an error rather than a
 * silent local-only snapshot.
 */
export async function runBackup(
	context: CommandContext,
): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);

	let target: ReturnType<typeof remoteFrom>;
	try {
		target = remoteFrom(context.env, text(context.flags.remote));
	} catch (error) {
		return { code: 1, stderr: (error as Error).message };
	}
	if (target === undefined && context.flags.remote !== undefined) {
		return {
			code: 1,
			stderr: `No place to copy to: set ${REMOTE_ENV} (user@host:folder), or give it: lattice backup --remote user@host:folder.`,
		};
	}

	const db = openNoteStore(paths);
	let made: ReturnType<typeof backupNow>;
	try {
		made = backupNow(db, paths.backups);
	} finally {
		db.close();
	}
	const lines = [`Snapshot written: ${made.path}`];
	if (target === undefined) {
		return { code: 0, stdout: `${lines.join("\n")}\n` };
	}

	context.report(`Copying to ${describeRemote(target)}.`);
	const copied = await copySnapshot(paths, made.path, target, context.env);
	if (!copied.ok) {
		return {
			code: 1,
			stdout: `${lines.join("\n")}\n`,
			stderr: `The snapshot is kept here, but copying it to ${describeRemote(target)} failed: ${copied.error}`,
		};
	}
	lines.push(`Copied to ${describeRemote(target)}/${made.file}`);
	return { code: 0, stdout: `${lines.join("\n")}\n` };
}
