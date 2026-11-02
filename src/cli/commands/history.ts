import { history, isRefusal } from "../../store/read.js";
import { resolvePaths } from "../../utils/paths.js";
import { openNoteStore } from "../database.js";
import { count, text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice history [note]`: the changes to one note or the whole store, newest
 * first, the same answer as the `history` tool. `--change <id>` gives one
 * change in full; `--who`, `--since` and `--limit` narrow the list.
 */
export function runHistory(context: CommandContext): CommandOutput {
	const db = openNoteStore(resolvePaths(context.env));
	try {
		const change = text(context.flags.change);
		const answer = history(db, {
			note: context.positionals[0],
			who: text(context.flags.who),
			since: text(context.flags.since),
			change: change === undefined ? undefined : count(change, 1, "--change"),
			limit:
				context.flags.limit === undefined
					? undefined
					: count(context.flags.limit, 20, "--limit"),
		});
		if (isRefusal(answer)) {
			return { code: 1, stderr: `${answer.refused} ${answer.next}` };
		}
		return { code: 0, stdout: `${JSON.stringify(answer, null, 2)}\n` };
	} finally {
		db.close();
	}
}
