import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import { embedPending } from "../../embed/run.js";
import { checkActiveSpace } from "../../embed/state.js";
import { applySync, planSync, type SyncReport } from "../../sync/index.js";
import { acquireLock, LockHeldError } from "../../sync/lock.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";
import { embedReportText } from "./embed.js";

/**
 * Index the bundle: everything new, changed, renamed or deleted since the
 * last run, and nothing else — then embed whatever still has no vector.
 *
 * The second phase is the same code `lattice embed` runs, and it runs even
 * when indexing found nothing to do, because a backlog can outlive the sync
 * that created it.
 */
export async function runSync(context: CommandContext): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	// Resolved before the lock, so a mistyped provider fails without leaving a
	// lock file behind.
	const provider = selectProvider(context.env, context.report);

	let lock: ReturnType<typeof acquireLock>;
	try {
		lock = acquireLock(paths.syncLock);
	} catch (error) {
		if (error instanceof LockHeldError) {
			return { code: 1, stderr: error.message };
		}
		throw error;
	}

	// Everything past the lock runs inside this try, so a failure anywhere
	// releases it rather than blocking every later sync.
	try {
		const db = openDatabase(paths.database);
		try {
			// Before a single document is read: indexing a bundle only to refuse
			// to embed it would leave the user with a half-done run to explain.
			const mismatch = checkActiveSpace(
				db,
				{ model: provider.model, dim: provider.dim },
				provider.source,
			);
			if (mismatch !== undefined) {
				return { code: 1, stderr: mismatch };
			}

			const plan = planSync(db, paths.docs);
			const indexed = isNoOp(plan)
				? `Nothing to sync. ${plan.unchanged} concept${plan.unchanged === 1 ? "" : "s"} already indexed.\n`
				: reportText(applySync(db, plan));
			const embedded = embedReportText(await embedPending(db, provider));
			return { code: 0, stdout: `${indexed}${embedded}` };
		} finally {
			db.close();
		}
	} finally {
		lock.release();
	}
}

function isNoOp(plan: ReturnType<typeof planSync>): boolean {
	return (
		plan.added.length === 0 &&
		plan.changed.length === 0 &&
		plan.renamed.length === 0 &&
		plan.deleted.length === 0
	);
}

function reportText(report: SyncReport): string {
	const lines = [
		`Indexed ${report.added.length} new, ${report.changed.length} changed, ` +
			`${report.renamed.length} renamed, ${report.deleted.length} deleted ` +
			`(${report.unchanged} unchanged).`,
		`Chunks written: ${report.chunks}`,
	];

	if (report.problems.length > 0) {
		lines.push("");
		lines.push(`Frontmatter problems (${report.problems.length}):`);
		for (const problem of report.problems) {
			lines.push(`  ${problem.path}: ${problem.problem}`);
		}
	}

	return `${lines.join("\n")}\n`;
}
