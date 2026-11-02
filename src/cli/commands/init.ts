import { existsSync, mkdirSync } from "node:fs";
import { selectProvider } from "../../embed/provider.js";
import { openStore } from "../../store/open.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Create the Lattice home directory and an empty note store, and fetch the
 * embedding model.
 *
 * Safe to run repeatedly: anything already in place is reported as such and
 * left alone. A store that is still empty is replaced by `lattice import`, so
 * running `init` first does not stand in the way of bringing notes in.
 */
export async function runInit(context: CommandContext): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);
	const lines: string[] = [];

	if (existsSync(paths.home)) {
		lines.push(`Exists  ${paths.home}`);
	} else {
		mkdirSync(paths.home, { recursive: true });
		lines.push(`Created ${paths.home}`);
	}

	const storeExisted = existsSync(paths.store);
	openStore(paths.store, { create: true }).close();
	lines.push(`${storeExisted ? "Exists " : "Created"} ${paths.store}`);

	// The model is fetched here, once, rather than in the middle of the first
	// write. A machine that cannot download is not a failed init: the directory
	// and store are real, and the user is told exactly what is missing.
	const modelProblem = await prepareProvider(context);
	if (modelProblem !== undefined) {
		lines.push("");
		lines.push(`Embeddings are not ready yet: ${modelProblem}`);
	}

	lines.push("");
	lines.push(
		storeExisted
			? "Lattice is already initialized."
			: "Lattice is ready. Register `lattice mcp` with your agent (see the README); to bring in Lattice 2's markdown files, run `lattice import`.",
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
