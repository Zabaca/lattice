import { existsSync, mkdirSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Create the Lattice home directory and index.
 *
 * Safe to run repeatedly: anything already in place is reported as such and
 * left alone.
 */
export async function runInit(context: CommandContext): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);
	const lines: string[] = [];

	for (const directory of [paths.home, paths.docs]) {
		if (existsSync(directory)) {
			lines.push(`Exists  ${directory}`);
		} else {
			mkdirSync(directory, { recursive: true });
			lines.push(`Created ${directory}`);
		}
	}

	const databaseExisted = existsSync(paths.database);
	openDatabase(paths.database, { create: true }).close();
	lines.push(`${databaseExisted ? "Exists " : "Created"} ${paths.database}`);

	// The model is fetched here, once, rather than in the middle of the first
	// sync. A machine that cannot download is not a failed init: the directory
	// and index are real, and the user is told exactly what is missing.
	const modelProblem = await prepareProvider(context);
	if (modelProblem !== undefined) {
		lines.push("");
		lines.push(`Embeddings are not ready yet: ${modelProblem}`);
	}

	lines.push("");
	lines.push(
		databaseExisted
			? "Lattice is already initialized."
			: "Lattice is ready. Put markdown in the docs directory and run `lattice sync`.",
	);

	return { code: 0, stdout: `${lines.join("\n")}\n` };
}

/**
 * Get the embedding provider ready, and return what stopped it if anything
 * did. Nothing here is fatal: `init` exists to make the home directory, and a
 * model that has to be placed by hand can be placed after it.
 */
async function prepareProvider(
	context: CommandContext,
): Promise<string | undefined> {
	try {
		const provider = selectProvider(context.env, context.report);
		await provider.prepare?.(context.report);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
