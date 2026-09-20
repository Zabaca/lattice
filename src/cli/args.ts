/**
 * A plain argument parser for the Lattice CLI.
 *
 * Deliberately small: a command name, positional arguments, and long flags.
 * It replaces the dependency-injection container the CLI used to boot.
 */

export interface ParsedArgs {
	/** The command name, or undefined when no command was given. */
	command?: string;
	/** Positional arguments following the command name. */
	positionals: string[];
	/** Long flags: `--flag` becomes true, `--flag=value` / `--flag value` become the value. */
	flags: Record<string, string | true>;
}

/**
 * Parse an argv tail (no executable or script path — just the user's words).
 *
 * Everything after a bare `--` is treated as a positional argument, so a query
 * that starts with a dash can still be passed through.
 */
export function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags: Record<string, string | true> = {};
	let command: string | undefined;
	let passthrough = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (passthrough) {
			positionals.push(arg);
			continue;
		}

		if (arg === "--") {
			passthrough = true;
			continue;
		}

		if (arg.startsWith("--")) {
			const body = arg.slice(2);
			const eq = body.indexOf("=");
			if (eq !== -1) {
				flags[body.slice(0, eq)] = body.slice(eq + 1);
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				flags[body] = next;
				i++;
				continue;
			}
			flags[body] = true;
			continue;
		}

		if (command === undefined) {
			command = arg;
			continue;
		}

		positionals.push(arg);
	}

	return { command, positionals, flags };
}
