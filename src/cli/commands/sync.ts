import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { applySync, planSync, type SyncReport } from "../../sync/index.js";
import { acquireLock, LockHeldError } from "../../sync/lock.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Index the bundle: everything new, changed, renamed or deleted since the
 * last run, and nothing else.
 */
export function runSync(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

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
			const plan = planSync(db, paths.docs);
			if (isNoOp(plan)) {
				return {
					code: 0,
					stdout: `Nothing to sync. ${plan.unchanged} concept${plan.unchanged === 1 ? "" : "s"} already indexed.\n`,
				};
			}
			return { code: 0, stdout: reportText(applySync(db, plan)) };
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
