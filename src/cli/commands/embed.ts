import { acquireLock, LockHeldError } from "../../embed/lock.js";
import { selectProvider } from "../../embed/provider.js";
import { type EmbedReport, embedPending } from "../../embed/run.js";
import { checkActiveSpace, describeSpace } from "../../embed/state.js";
import { resolvePaths } from "../../utils/paths.js";
import { openNoteStore, storeProblem } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Embed whatever is still waiting in the note store.
 *
 * A write that landed while the provider was unavailable leaves its passages
 * without a vector (found by keyword meanwhile); running this finishes them.
 * `--reembed` moves the whole store to a changed model.
 */
export async function runEmbed(
	context: CommandContext,
): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);

	const problem = storeProblem(paths);
	if (problem !== undefined) {
		return { code: 1, stderr: problem };
	}

	const provider = selectProvider(context.env, context.report);

	let lock: ReturnType<typeof acquireLock>;
	try {
		lock = acquireLock(paths.embedLock);
	} catch (error) {
		if (error instanceof LockHeldError) {
			return { code: 1, stderr: error.message };
		}
		throw error;
	}

	try {
		const db = openNoteStore(paths);
		try {
			// `--reembed` is the one command allowed to work in a space the
			// store is not in; it is how a user answers the refusal.
			const reEmbed = context.flags.reembed === true;
			if (!reEmbed) {
				const mismatch = checkActiveSpace(
					db,
					{ model: provider.model, dim: provider.dim },
					provider.source,
				);
				if (mismatch !== undefined) {
					return { code: 1, stderr: mismatch };
				}
			}

			const report = await embedPending(db, provider, {
				retryFailed: context.flags["retry-failed"] !== undefined,
				reEmbed,
			});
			return { code: 0, stdout: embedReportText(report) };
		} finally {
			db.close();
		}
	} finally {
		lock.release();
	}
}

/** What `embed` reports. */
export function embedReportText(report: EmbedReport): string {
	const lines = [
		`Embedded ${report.chunks} chunk${report.chunks === 1 ? "" : "s"} and ` +
			`${report.concepts} concept${report.concepts === 1 ? "" : "s"} ` +
			`with ${report.model} (${report.dim} dimensions).`,
	];

	if (report.failed > 0) {
		lines.push(`Failed: ${report.failed}`);
	}
	if (report.swapped === true && report.replaced !== undefined) {
		lines.push(
			`The store is now in ${report.model}; the ${describeSpace(report.replaced)} vectors have been removed.`,
		);
	} else if (report.swapped === false) {
		lines.push(
			"The store is still on its previous model, and its vectors are untouched: " +
				"not everything has been embedded in the new one yet. Run " +
				"`lattice embed --reembed` again to finish" +
				(report.skipped > 0 || report.failed > 0
					? ", adding `--retry-failed` if the remaining targets are recorded as permanently failed."
					: "."),
		);
	}

	if (report.skipped > 0) {
		lines.push(
			`Permanently failed: ${report.skipped} (run \`lattice embed --retry-failed\` to try again)`,
		);
	}

	return `${lines.join("\n")}\n`;
}
