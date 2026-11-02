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
 * `--remote` also copies the new snapshot to another machine over ssh, to the
 * place `LATTICE_BACKUP_REMOTE` names or the one given (`--remote
 * user@host:folder`). The snapshot is kept either way; a copy that fails exits
 * 1 and says why.
 */
export async function runBackup(
	context: CommandContext,
): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);

	let target: ReturnType<typeof remoteFrom>;
	if (context.flags.remote !== undefined) {
		try {
			target = remoteFrom(context.env, text(context.flags.remote));
		} catch (error) {
			return { code: 1, stderr: (error as Error).message };
		}
		if (target === undefined) {
			return {
				code: 1,
				stderr: `No place to copy to: set ${REMOTE_ENV} (user@host:folder), or give it: lattice backup --remote user@host:folder.`,
			};
		}
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
	const copied = await copySnapshot(
		paths.backups,
		made.path,
		target,
		context.env,
	);
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
