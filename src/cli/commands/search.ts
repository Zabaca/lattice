import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { type SearchHit, search } from "../../search/search.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/** Concepts returned when `--limit` is not given. */
const DEFAULT_LIMIT = 10;
/** Passages shown per concept when `--chunks` is not given. */
const DEFAULT_CHUNKS_PER_CONCEPT = 2;

/**
 * Search the index for passages matching a query.
 *
 * Nothing here decides relevance — that is `src/search/search.ts`. This reads
 * the flags, refuses the ones that cannot mean anything, and renders.
 */
export function runSearch(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	let limit: number;
	let chunksPerConcept: number;
	let asOf: number;
	try {
		limit = count(context.flags.limit, DEFAULT_LIMIT, "--limit");
		chunksPerConcept = count(
			context.flags.chunks ?? context.flags["chunks-per-concept"],
			DEFAULT_CHUNKS_PER_CONCEPT,
			"--chunks",
		);
		asOf = instant(context.flags["as-of"]);
	} catch (error) {
		return { code: 1, stderr: (error as Error).message };
	}

	const db = openDatabase(paths.database);
	try {
		const result = search(db, {
			query: context.positionals[0],
			limit,
			chunksPerConcept,
			asOf,
			type: text(context.flags.type),
			tag: text(context.flags.tag),
			dir: text(context.flags.dir),
			status: text(context.flags.status),
			trust: text(context.flags.trust),
			includeDeprecated: context.flags["include-deprecated"] !== undefined,
		});

		if (context.flags.json !== undefined) {
			return {
				code: 0,
				stdout: `${JSON.stringify({
					query: context.positionals[0],
					terms: result.terms,
					mode: result.mode ?? null,
					hits: result.hits,
				})}\n`,
			};
		}

		return { code: 0, stdout: render(result.hits) };
	} finally {
		db.close();
	}
}

/** A flag's value as text; `--flag` with no value is not a value. */
function text(flag: string | true | undefined): string | undefined {
	return typeof flag === "string" ? flag : undefined;
}

/** A positive whole number, or the reason it was refused. */
function count(
	flag: string | true | undefined,
	fallback: number,
	name: string,
): number {
	if (flag === undefined) {
		return fallback;
	}
	const value = typeof flag === "string" ? Number(flag) : Number.NaN;
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} expects a positive whole number, got: ${flag}`);
	}
	return value;
}

/** The instant staleness is judged against: `--as-of`, or now. */
function instant(flag: string | true | undefined): number {
	if (flag === undefined) {
		return Date.now();
	}
	const at = typeof flag === "string" ? Date.parse(flag) : Number.NaN;
	if (Number.isNaN(at)) {
		throw new Error(`--as-of expects a date, got: ${flag}`);
	}
	return at;
}

function render(hits: SearchHit[]): string {
	if (hits.length === 0) {
		return "No matches.\n";
	}

	const lines: string[] = [];
	hits.forEach((hit, index) => {
		const labels = [hit.type, hit.status, hit.trust].filter(
			(label): label is string => label !== null,
		);
		if (hit.stale) {
			labels.push("stale");
		}
		lines.push(
			`${index + 1}. ${hit.path}${hit.title === null ? "" : ` — ${hit.title}`}` +
				`  [${labels.join(" · ")}]  ${hit.score.toFixed(2)}`,
		);
		for (const chunk of hit.chunks) {
			const where =
				chunk.headingPath === "" ? `#${chunk.ordinal}` : chunk.headingPath;
			lines.push(`   ${where}  (lines ${chunk.startLine}-${chunk.endLine})`);
			lines.push(`   ${chunk.snippet}`);
		}
		lines.push("");
	});

	return `${lines.join("\n")}`;
}
