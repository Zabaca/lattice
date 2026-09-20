import { existsSync, mkdirSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Create the Lattice home directory and index.
 *
 * Safe to run repeatedly: anything already in place is reported as such and
 * left alone.
 */
export function runInit(context: CommandContext): CommandOutput {
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

	lines.push("");
	lines.push(
		databaseExisted
			? "Lattice is already initialized."
			: "Lattice is ready. Put markdown in the docs directory and run `lattice sync`.",
	);

	return { code: 0, stdout: `${lines.join("\n")}\n` };
}
