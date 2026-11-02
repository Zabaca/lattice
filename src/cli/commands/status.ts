import { selectProvider } from "../../embed/provider.js";
import type { VectorSpace } from "../../embed/state.js";
import { remoteSetting } from "../../store/remote.js";
import { collectStats, type Stats } from "../../store/stats.js";
import { resolvePaths } from "../../utils/paths.js";
import { openNoteStore } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * `lattice status`: what the note store holds and how its search is doing. The
 * same numbers the `stats` tool gives an agent, for a person.
 */
export function runStatus(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);
	const db = openNoteStore(paths);
	try {
		let configured: VectorSpace | undefined;
		let problem: string | undefined;
		try {
			const provider = selectProvider(context.env);
			configured = { model: provider.model, dim: provider.dim };
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
		const setting = remoteSetting(context.env);
		const stats = collectStats(db, {
			configured,
			configuredProblem: problem,
			paths,
			remote: { label: setting.label, problem: setting.problem },
		});

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
			`Off Mac:   ${offMac(stats.remote_copy)}`,
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

/** "3 h" as "3 h ago", and "just now" as it is. */
function ago(age: string | null): string {
	return age === "just now" || age === null ? (age ?? "") : `${age} ago`;
}

/** The copy of the snapshots on another machine, in a line. */
function offMac(copy: Stats["remote_copy"]): string {
	if (copy.error !== null) {
		return `${copy.target ?? "not set up"}: ${copy.error}${copy.last_ok === null ? "" : ` (last good copy ${copy.last_ok}, ${ago(copy.last_ok_age)})`}`;
	}
	if (copy.target === null) {
		return "not set up (LATTICE_BACKUP_REMOTE=user@host:folder copies each day's snapshot there)";
	}
	return copy.last_ok === null
		? `${copy.target}, nothing copied yet (the first write of the day sends one)`
		: `last copy ${copy.last_ok} (${ago(copy.last_ok_age)}) to ${copy.target}`;
}
