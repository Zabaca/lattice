import { existsSync, readFileSync } from "node:fs";
import { selectProvider } from "../../embed/provider.js";
import { importNotes } from "../../store/import.js";
import { renderReport } from "../../store/verify.js";
import { resolvePaths } from "../../utils/paths.js";
import { text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Build a fresh note store from today's bundle and Lattice 1's library.
 *
 * Nothing in the home is changed except the new store. Embedding the library
 * is the slow part (minutes, and a lot of memory), which is why it happens
 * here, once, and never inside a session's server.
 */
export async function runImport(
	context: CommandContext,
): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);

	const docs =
		text(context.flags.docs) ??
		(context.flags["no-docs"] === undefined && existsSync(paths.docs)
			? paths.docs
			: undefined);
	const library =
		text(context.flags.library) ??
		(context.flags["no-library"] === undefined && existsSync(paths.library)
			? paths.library
			: undefined);
	if (docs === undefined && library === undefined) {
		return {
			code: 1,
			stderr:
				`Nothing to import: ${paths.docs} and ${paths.library} do not exist. ` +
				"Name a bundle with --docs <dir> or a library with --library <dir>.",
		};
	}

	let questions: string[] = [];
	const questionsFile = text(context.flags.questions);
	if (questionsFile !== undefined) {
		if (!existsSync(questionsFile)) {
			return { code: 1, stderr: `No questions file at ${questionsFile}.` };
		}
		questions = readFileSync(questionsFile, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	}

	const report = await importNotes({
		storePath: paths.store,
		docs,
		library,
		oldIndex: existsSync(paths.database) ? paths.database : undefined,
		provider: selectProvider(context.env, context.report),
		report: context.report,
		questions,
	});

	return {
		code: report.clean ? 0 : 1,
		stdout:
			context.flags.json === undefined
				? renderReport(report)
				: `${JSON.stringify(report, null, 2)}\n`,
	};
}
