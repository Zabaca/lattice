import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import type { VectorSpace } from "../../embed/state.js";
import { checkActiveSpace } from "../../embed/state.js";
import { type SearchHit, search, searchConcepts } from "../../search/search.js";
import type { SemanticInput } from "../../search/vector.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/** Concepts returned when `--limit` is not given. */
const DEFAULT_LIMIT = 10;
/** Passages shown per concept when `--chunks` is not given. */
const DEFAULT_CHUNKS_PER_CONCEPT = 2;
/** Neighbours added below the direct hits when `--expand` is not given. */
const DEFAULT_EXPAND = 3;

/**
 * Search the index for passages matching a query.
 *
 * Nothing here decides relevance — that is `src/search/search.ts`. This reads
 * the flags, refuses the ones that cannot mean anything, and renders.
 */
export async function runSearch(
	context: CommandContext,
): Promise<CommandOutput> {
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
	let expand: number;
	try {
		limit = count(context.flags.limit, DEFAULT_LIMIT, "--limit");
		chunksPerConcept = count(
			context.flags.chunks ?? context.flags["chunks-per-concept"],
			DEFAULT_CHUNKS_PER_CONCEPT,
			"--chunks",
		);
		asOf = instant(context.flags["as-of"]);
		expand =
			context.flags["no-expand"] !== undefined
				? 0
				: count(context.flags.expand, DEFAULT_EXPAND, "--expand");
	} catch (error) {
		return { code: 1, stderr: (error as Error).message };
	}

	const embedded = await embedQuery(context.positionals[0], context);

	const db = openDatabase(paths.database);
	try {
		// A query embedded by one model cannot be compared against vectors
		// written by another, and answering anyway would be worse than not
		// answering: the results would look ordinary. A provider that could
		// not be built at all is a different matter — that degrades to the
		// keyword leg below, rather than refusing.
		if (embedded.space !== undefined) {
			const mismatch = checkActiveSpace(
				db,
				embedded.space,
				embedded.source ?? "",
			);
			if (mismatch !== undefined) {
				return { code: 1, stderr: mismatch };
			}
		}

		// "Which document" and "which passage" are different questions over the
		// same index, asked with the same filters.
		const ask = context.flags.concepts !== undefined ? searchConcepts : search;
		const result = ask(db, {
			query: context.positionals[0],
			limit,
			chunksPerConcept,
			asOf,
			expand,
			semantic: embedded.semantic,
			semanticUnavailable: embedded.reason,
			type: text(context.flags.type),
			tag: text(context.flags.tag),
			dir: text(context.flags.dir),
			status: text(context.flags.status),
			trust: text(context.flags.trust),
			includeDeprecated: context.flags["include-deprecated"] !== undefined,
		});

		// A caller that would rather fail than be told the answer is weaker.
		if (result.degraded && context.flags["require-embeddings"] !== undefined) {
			return {
				code: 1,
				stderr:
					`--require-embeddings was given and the semantic leg could not run: ` +
					`${result.degradedReason}`,
			};
		}

		if (context.flags.json !== undefined) {
			return {
				code: 0,
				stdout: `${JSON.stringify({
					query: context.positionals[0],
					terms: result.terms,
					mode: result.mode ?? null,
					degraded: result.degraded,
					degradedReason: result.degradedReason ?? null,
					hits: result.hits,
				})}\n`,
			};
		}

		return {
			code: 0,
			stdout:
				(result.degraded ? `Keyword-only: ${result.degradedReason}.\n\n` : "") +
				render(result.hits),
		};
	} finally {
		db.close();
	}
}

/**
 * The query as a vector, or the reason there is none.
 *
 * A search must still answer when no model will: a provider that cannot be
 * selected or cannot embed costs the semantic leg, not the command. The reason
 * travels with the result so the caller can say the answer is weaker than
 * usual rather than quietly returning a worse one.
 */
async function embedQuery(
	query: string,
	context: CommandContext,
): Promise<{
	semantic?: SemanticInput;
	reason?: string;
	/** The space the query was embedded into, when there was one. */
	space?: VectorSpace;
	/** Where that model name came from, for the model-change message. */
	source?: string;
}> {
	try {
		const provider = selectProvider(context.env, context.report);
		const space = { model: provider.model, dim: provider.dim };
		// `embedQuery`, not `embed`: an asymmetric model is trained to be told
		// that this is a question rather than a passage, and a query embedded
		// as a passage lands in the wrong part of the space.
		const [vector] = await provider.embedQuery([query]);
		return {
			semantic: { vector, model: provider.model, dim: provider.dim },
			space,
			source: provider.source,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { reason: `the query could not be embedded: ${message}` };
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
		if (hit.via !== undefined) {
			labels.push(`${hit.via.relation} of ${hit.via.from}`);
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
