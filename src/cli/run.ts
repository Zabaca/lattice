/**
 * The Lattice CLI seam.
 *
 * `runCli` takes arguments and an environment and returns an exit code with
 * the text that would have gone to stdout and stderr. It never reads
 * `process.argv`, `process.env` or the real home directory, and it never
 * throws — which is what makes it the surface every test drives.
 */

import { parseArgs } from "./args.js";
import { runEmbed } from "./commands/embed.js";
import { runInit } from "./commands/init.js";
import { runSql } from "./commands/sql.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";

export interface CliOptions {
	/** The argv tail: no executable, no script path. */
	argv: string[];
	/** The environment the command should see. `LATTICE_HOME` overrides the default home. */
	env: Record<string, string | undefined>;
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandContext {
	positionals: string[];
	flags: Record<string, string | true>;
	env: Record<string, string | undefined>;
}

export interface CommandOutput {
	code: number;
	stdout?: string;
	stderr?: string;
}

interface CommandSpec {
	/** Usage line shown for this command alone. */
	usage: string;
	summary: string;
	/** Names of the required positional arguments, in order. */
	requiredArgs: string[];
	run(context: CommandContext): Promise<CommandOutput> | CommandOutput;
}

const COMMANDS: Record<string, CommandSpec> = {
	init: {
		usage: "lattice init",
		summary: "Create the Lattice home directory and database",
		requiredArgs: [],
		run: runInit,
	},
	status: {
		usage: "lattice status",
		summary: "Show what is indexed",
		requiredArgs: [],
		run: runStatus,
	},
	sync: {
		usage: "lattice sync",
		summary: "Index the OKF bundle",
		requiredArgs: [],
		run: runSync,
	},
	embed: {
		usage: "lattice embed [--retry-failed]",
		summary: "Embed whatever is still waiting for a vector",
		requiredArgs: [],
		run: runEmbed,
	},
	sql: {
		usage: "lattice sql <query>",
		summary: "Run a read-only SQL query against the index",
		requiredArgs: ["query"],
		run: runSql,
	},
	search: {
		usage: "lattice search <query>",
		summary: "Search the index",
		requiredArgs: ["query"],
		run: () => ({
			code: 1,
			stderr: "search is not implemented yet.",
		}),
	},
};

function usageText(): string {
	const lines = ["Usage: lattice <command> [options]", "", "Commands:"];
	const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
	for (const [name, spec] of Object.entries(COMMANDS)) {
		lines.push(`  ${name.padEnd(width)}  ${spec.summary}`);
	}
	return lines.join("\n");
}

function commandUsageText(spec: CommandSpec): string {
	return `Usage: ${spec.usage}`;
}

export async function runCli(options: CliOptions): Promise<CliResult> {
	const { command, positionals, flags } = parseArgs(options.argv);

	if (command === undefined) {
		return { code: 1, stdout: "", stderr: usageText() };
	}

	const spec = COMMANDS[command];
	if (spec === undefined) {
		return {
			code: 1,
			stdout: "",
			stderr: `Unknown command: ${command}\n\n${usageText()}`,
		};
	}

	const missing = spec.requiredArgs[positionals.length];
	if (missing !== undefined) {
		return {
			code: 1,
			stdout: "",
			stderr: `Missing required argument: <${missing}>\n\n${commandUsageText(spec)}`,
		};
	}

	try {
		const output = await spec.run({ positionals, flags, env: options.env });
		return {
			code: output.code,
			stdout: output.stdout ?? "",
			stderr: output.stderr ?? "",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: 1, stdout: "", stderr: message };
	}
}
