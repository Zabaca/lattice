#!/usr/bin/env bun

/**
 * The process adapter over the CLI seam: argv and env in, streams and an exit
 * code out. All behavior lives in `runCli`.
 */

import { runCli } from "./cli/run.js";

const result = await runCli({
	argv: process.argv.slice(2),
	env: process.env,
});

if (result.stdout) {
	process.stdout.write(result.stdout);
}
if (result.stderr) {
	process.stderr.write(
		result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`,
	);
}

process.exit(result.code);
