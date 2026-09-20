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

	for (const directory of [paths.home, paths.docs, paths.models]) {
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

	// The model is fetched here so the cost is paid once, watched, at setup
	// rather than in the middle of someone's first sync. Progress arrives as a
	// line per downloaded file: `runCli` returns its output as a string, so
	// there is no stream to rewrite a percentage into.
	const provider = selectProvider(context.env);
	if (provider.ensureReady !== undefined) {
		lines.push("");
		lines.push(`Model: ${provider.model}`);
		const progress: string[] = [];
		await provider.ensureReady((line) => progress.push(line));
		lines.push(...(progress.length > 0 ? progress : ["  already cached"]));
	}

	lines.push("");
	lines.push(
		databaseExisted
			? "Lattice is already initialized."
			: "Lattice is ready. Put markdown in the docs directory and run `lattice sync`.",
	);

	return { code: 0, stdout: `${lines.join("\n")}\n` };
}
