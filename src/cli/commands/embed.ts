import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import { type EmbedReport, embedPending } from "../../embed/run.js";
import { acquireLock, LockHeldError } from "../../sync/lock.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Embed whatever is still waiting, without re-reading a single markdown file.
 *
 * This is the same phase `lattice sync` runs after indexing, so a backlog left
 * by an interrupted sync — or by a provider that was unavailable at the time —
 * is finished by running this on its own.
 */
export async function runEmbed(
	context: CommandContext,
): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const provider = selectProvider(context.env);

	let lock: ReturnType<typeof acquireLock>;
	try {
		lock = acquireLock(paths.syncLock);
	} catch (error) {
		if (error instanceof LockHeldError) {
			return { code: 1, stderr: error.message };
		}
		throw error;
	}

	try {
		const db = openDatabase(paths.database);
		try {
			const report = await embedPending(db, provider, {
				retryFailed: context.flags["retry-failed"] === true,
			});
			return { code: 0, stdout: embedReportText(report) };
		} finally {
			db.close();
		}
	} finally {
		lock.release();
	}
}

/** The one shape both `embed` and `sync` report their embedding work in. */
export function embedReportText(report: EmbedReport): string {
	const lines = [
		`Embedded ${report.chunks} chunk${report.chunks === 1 ? "" : "s"} and ` +
			`${report.concepts} concept${report.concepts === 1 ? "" : "s"} ` +
			`with ${report.model} (${report.dim} dimensions).`,
	];

	if (report.failed > 0) {
		lines.push(`Failed: ${report.failed}`);
	}
	if (report.skipped > 0) {
		lines.push(
			`Permanently failed: ${report.skipped} (run \`lattice embed --retry-failed\` to try again)`,
		);
	}

	return `${lines.join("\n")}\n`;
}
