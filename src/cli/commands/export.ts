import { resolve, sep } from "node:path";
import { exportStore } from "../../store/export.js";
import { resolvePaths } from "../../utils/paths.js";
import { openNoteStore } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice export [dir]`: write every note as a markdown file under its type's
 * folder. The export is a copy, marked as one, and nothing reads it back; the
 * folder defaults to `export` under the Lattice home. A folder that holds
 * anything but an earlier export is refused, and a re-export removes the files
 * of notes renamed or archived since (archived notes are not exported).
 */
export function runExport(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);
	const db = openNoteStore(paths);
	try {
		const dir = resolve(context.positionals[0] ?? paths.export);
		// `lattice import` looks for Lattice 2's files in the home's `docs`, and a
		// copy written there would look like a second source of notes.
		const docs = resolve(paths.docs);
		const within = (inner: string, outer: string): boolean =>
			inner === outer || inner.startsWith(outer + sep);
		if (within(dir, docs) || within(docs, dir)) {
			return {
				code: 1,
				stderr: `${dir} is, or holds, the folder ${docs}, where \`lattice import\` looks for Lattice 2's files. Name another folder for the export.`,
			};
		}
		const done = exportStore(db, dir);
		return {
			code: 0,
			stdout: `Exported ${done.notes} notes to ${done.dir} (${done.bytes} bytes). It is a copy: Lattice never reads it back.\n`,
		};
	} finally {
		db.close();
	}
}
