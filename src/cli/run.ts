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
import { runRels } from "./commands/rels.js";
import { runSearch } from "./commands/search.js";
import { runSql } from "./commands/sql.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";

export interface CliOptions {
	/** The argv tail: no executable, no script path. */
	argv: string[];
	/** The environment the command should see. `LATTICE_HOME` overrides the default home. */
	env: Record<string, string | undefined>;
	/**
	 * Where progress goes while a command is still running — a model download
	 * is minutes long, and a result returned at the end is not progress.
	 * Whatever is reported here is also collected into the result's `progress`,
	 * so a test sees it without having to watch for it.
	 */
	onProgress?: (line: string) => void;
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
	/** The progress lines the command reported, in order. */
	progress: string[];
}

export interface CommandContext {
	positionals: string[];
	flags: Record<string, string | true>;
	env: Record<string, string | undefined>;
	/** Say what is happening, now, to whoever is waiting. */
	report(line: string): void;
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
		usage: "lattice embed [--retry-failed] [--reembed]",
		summary: "Embed whatever is still waiting for a vector",
		requiredArgs: [],
		run: runEmbed,
	},
	rels: {
		usage: "lattice rels <concept> [--json]",
		summary:
			"Show what a concept links to, what links back, and what is missing",
		requiredArgs: ["concept"],
		run: runRels,
	},
	sql: {
		usage: "lattice sql <query>",
		summary: "Run a read-only SQL query against the index",
		requiredArgs: ["query"],
		run: runSql,
	},
	search: {
		usage:
			"lattice search <query> [--json] [--limit n] [--chunks n]\n" +
			"       [--concepts] [--expand n | --no-expand] [--require-embeddings]\n" +
			"       [--candidates n] [--require-rerank]\n" +
			"       [--type t] [--tag t] [--dir d] [--status s] [--trust t]\n" +
			"       [--include-deprecated] [--as-of date]",
		summary: "Search the index by keyword and by meaning at once",
		requiredArgs: ["query"],
		run: runSearch,
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
		return { code: 1, stdout: "", stderr: usageText(), progress: [] };
	}

	const spec = COMMANDS[command];
	if (spec === undefined) {
		return {
			code: 1,
			stdout: "",
			stderr: `Unknown command: ${command}\n\n${usageText()}`,
			progress: [],
		};
	}

	const missing = spec.requiredArgs[positionals.length];
	if (missing !== undefined) {
		return {
			code: 1,
			stdout: "",
			stderr: `Missing required argument: <${missing}>\n\n${commandUsageText(spec)}`,
			progress: [],
		};
	}

	const progress: string[] = [];
	const report = (line: string): void => {
		progress.push(line);
		options.onProgress?.(line);
	};
	try {
		const output = await spec.run({
			positionals,
			flags,
			env: options.env,
			report,
		});
		return {
			code: output.code,
			stdout: output.stdout ?? "",
			stderr: output.stderr ?? "",
			progress,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: 1, stdout: "", stderr: message, progress };
	}
}
