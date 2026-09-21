import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import {
	type EmbeddingProvider,
	selectProvider,
} from "../../embed/provider.js";
import { type EmbedReport, embedPending } from "../../embed/run.js";
import { checkActiveSpace } from "../../embed/state.js";
import {
	applySync,
	planSync,
	type SyncPlan,
	type SyncReport,
} from "../../sync/index.js";
import { acquireLock, LockHeldError } from "../../sync/lock.js";
import { type LatticePaths, resolvePaths } from "../../utils/paths.js";
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

	let outcome: SyncOutcome;
	try {
		outcome = await syncBundle(paths, provider);
	} catch (error) {
		if (error instanceof LockHeldError || error instanceof SpaceMismatchError) {
			return { code: 1, stderr: error.message };
		}
		throw error;
	}
	const indexed =
		outcome.report === null
			? `Nothing to sync. ${outcome.plan.unchanged} concept${outcome.plan.unchanged === 1 ? "" : "s"} already indexed.\n`
			: reportText(outcome.report);
	return { code: 0, stdout: `${indexed}${embedReportText(outcome.embedded)}` };
}

/** The index and the configuration name different vector spaces; the message says which and what to do. */
export class SpaceMismatchError extends Error {}

export interface SyncOutcome {
	plan: SyncPlan;
	/** What was done, or null when the plan was a no-op and nothing was. */
	report: SyncReport | null;
	embedded: EmbedReport;
}

/**
 * One sync, under the lock: refuse a space mismatch before a single
 * document is read, plan, apply, embed the backlog. `lattice sync` and
 * `lattice research` both run this; only what they say about it differs.
 * A held lock and a mismatch are typed so a caller can map them to an exit.
 */
export async function syncBundle(
	paths: LatticePaths,
	provider: EmbeddingProvider,
): Promise<SyncOutcome> {
	const lock = acquireLock(paths.syncLock);
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
				throw new SpaceMismatchError(mismatch);
			}

			const plan = planSync(db, paths.docs);
			const report = isNoOp(plan) ? null : applySync(db, plan);
			const embedded = await embedPending(db, provider);
			return { plan, report, embedded };
		} finally {
			db.close();
		}
	} finally {
		lock.release();
	}
}

function isNoOp(plan: SyncPlan): boolean {
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
