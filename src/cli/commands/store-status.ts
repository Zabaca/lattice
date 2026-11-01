import { selectProvider } from "../../embed/provider.js";
import type { VectorSpace } from "../../embed/state.js";
import { collectStats } from "../../store/stats.js";
import { resolvePaths } from "../../utils/paths.js";
import { openTarget } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice status --store`: what the note store holds and how its search is
 * doing. The same numbers the `stats` tool gives an agent, for a person.
 */
export function runStoreStatus(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);
	const db = openTarget(paths, context.flags);
	try {
		let configured: VectorSpace | undefined;
		let problem: string | undefined;
		try {
			const provider = selectProvider(context.env);
			configured = { model: provider.model, dim: provider.dim };
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
		const stats = collectStats(db, configured, problem, paths.backups);

		if (context.flags.json !== undefined) {
			return { code: 0, stdout: `${JSON.stringify(stats, null, 2)}\n` };
		}

		const types = Object.entries(stats.notes.by_type)
			.map(([type, n]) => `${n} ${type}`)
			.join(", ");
		const lines = [
			`Store: ${paths.store}`,
			"",
			`Notes:     ${stats.notes.total} (${types}); ${stats.notes.old} old, ${stats.notes.archived} archived`,
			`Sections:  ${stats.sections.total}; ${stats.sections.unchecked} unchecked, ${stats.sections.by_agent} checked by an agent, ${stats.sections.by_james} by James`,
			`Changes:   ${stats.changes.last_7_days} in the last 7 days${
				stats.changes.last === null
					? ""
					: `; last ${stats.changes.last.kind} of ${stats.changes.last.note} at ${stats.changes.last.at}`
			}`,
			`Questions: ${stats.questions.last_7_days} in the last 7 days from ${stats.questions.projects} projects`,
			`Backup:    ${stats.last_backup === null ? "none yet (lattice backup takes one)" : `last at ${stats.last_backup}`}`,
			"",
			stats.search.model === null
				? "Model:    unavailable"
				: `Model:    ${stats.search.model} (${stats.search.dim} dimensions)`,
			`Passages:  ${stats.search.passages}; ${stats.search.vectors} with vectors, ${stats.search.waiting} waiting, ${stats.search.failed} failed`,
			stats.search.ok
				? "Search:    full"
				: `Search:    degraded: ${stats.search.problem}`,
		];
		if (stats.wanted.length > 0) {
			lines.push("", "Most wanted (linked to, not written):");
			for (const entry of stats.wanted) {
				lines.push(`  ${entry.note} (${entry.wanted_by})`);
			}
		}
		return { code: 0, stdout: `${lines.join("\n")}\n` };
	} finally {
		db.close();
	}
}
