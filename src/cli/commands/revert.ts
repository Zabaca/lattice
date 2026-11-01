import { selectProvider } from "../../embed/provider.js";
import { dailyBackup } from "../../store/backup.js";
import { isRefusal } from "../../store/read.js";
import { revert } from "../../store/undo.js";
import { resolvePaths } from "../../utils/paths.js";
import { openTarget } from "../database.js";
import { count, text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice revert <change>`: undo one change as a new change, the same as the
 * `revert` tool. `lattice revert <note> --version <n> --current <m>` puts a whole note back as
 * it was at version n; m is the version it is at now, as you read it. `--reason` and `--by` are recorded with the change.
 */
export async function runRevert(
	context: CommandContext,
): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);
	const db = openTarget(paths, { store: true });
	try {
		const first = context.positionals[0];
		const version = text(context.flags.version);
		const byNote = version !== undefined;
		if (!first) {
			return {
				code: 1,
				stderr:
					"Give the change to undo (lattice history lists them), or a note and --version: lattice revert <change> | lattice revert <note> --version <n>.",
			};
		}

		let provider: ReturnType<typeof selectProvider> | { unavailable: string };
		try {
			provider = selectProvider(context.env);
		} catch (error) {
			provider = {
				unavailable: error instanceof Error ? error.message : String(error),
			};
		}
		dailyBackup(db, paths.backups);
		const answer = await revert(
			{
				db,
				provider: () => provider,
				who: { client: "lattice cli", project: context.cwd },
			},
			byNote
				? {
						note: first,
						version: count(version, 1, "--version"),
						current:
							context.flags.current === undefined
								? undefined
								: count(context.flags.current, 1, "--current"),
						reason: text(context.flags.reason),
						by: text(context.flags.by),
					}
				: {
						change: count(first, 1, "<change>"),
						reason: text(context.flags.reason),
						by: text(context.flags.by),
					},
		);
		if (isRefusal(answer)) {
			return { code: 1, stderr: `${answer.refused} ${answer.next}` };
		}
		return { code: 0, stdout: `${JSON.stringify(answer, null, 2)}\n` };
	} finally {
		db.close();
	}
}
