import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { type SearchResult, search } from "../../search/search.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/** Concepts reported unless `--limit` says otherwise. */
const DEFAULT_LIMIT = 10;

/**
 * Passages reported per concept. Two is enough to show a document answers the
 * question from more than one angle, and few enough that a long document
 * cannot fill the page.
 */
const DEFAULT_CHUNKS_PER_CONCEPT = 2;

/**
 * Search the index and print the ranked passages.
 *
 * Keyword only: this command never needs an embedding model, which is also
 * what makes it the fallback when one is unavailable.
 */
export function runSearch(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const limit = readCount(context.flags.limit, DEFAULT_LIMIT);
	if (limit === undefined) {
		return { code: 1, stderr: "--limit must be a positive whole number." };
	}
	const chunksPerConcept = readCount(
		context.flags.chunks,
		DEFAULT_CHUNKS_PER_CONCEPT,
	);
	if (chunksPerConcept === undefined) {
		return { code: 1, stderr: "--chunks must be a positive whole number." };
	}

	const db = openDatabase(paths.database);
	try {
		db.exec("PRAGMA query_only = ON");
		const results = search(db, {
			query: context.positionals[0],
			limit,
			chunksPerConcept,
			types: readList(context.flags.type),
			tags: readList(context.flags.tag),
			dirs: readList(context.flags.dir),
			statuses: readList(context.flags.status),
			trusts: readList(context.flags.trust),
			includeDeprecated: context.flags["include-deprecated"] !== undefined,
		});

		if (context.flags.json !== undefined) {
			return { code: 0, stdout: `${JSON.stringify(results, null, 2)}\n` };
		}
		return { code: 0, stdout: format(results) };
	} finally {
		db.close();
	}
}

/** A comma-separated flag value as a list, or undefined when the flag is absent. */
function readList(value: string | true | undefined): string[] | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	return entries.length === 0 ? undefined : entries;
}

/** A positive whole number, the fallback when absent, or undefined when unusable. */
function readCount(
	value: string | true | undefined,
	fallback: number,
): number | undefined {
	if (value === undefined) {
		return fallback;
	}
	if (value === true) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function format(results: SearchResult[]): string {
	if (results.length === 0) {
		return "No results.\n";
	}

	const lines: string[] = [];
	results.forEach((result, index) => {
		lines.push(
			`${index + 1}. ${result.title ?? result.identifier}  (${result.path})`,
		);
		lines.push(`   ${attributes(result)}`);
		for (const chunk of result.chunks) {
			const where =
				chunk.headingPath === "" ? "(no heading)" : chunk.headingPath;
			lines.push(`   ${where}  [lines ${chunk.startLine}-${chunk.endLine}]`);
			for (const line of chunk.snippet.split("\n")) {
				lines.push(`     ${line}`);
			}
		}
		lines.push("");
	});

	return `${lines.join("\n").trimEnd()}\n`;
}

/** The facts about a concept a reader judges a hit by, in one line. */
function attributes(result: SearchResult): string {
	const parts: string[] = [];
	if (result.type !== undefined) {
		parts.push(result.type);
	}
	if (result.status !== undefined) {
		parts.push(result.status);
	}
	parts.push(result.trust);
	if (result.stale) {
		parts.push("stale");
	}
	parts.push(`score ${result.score.toFixed(2)}`);
	return parts.join(" · ");
}
