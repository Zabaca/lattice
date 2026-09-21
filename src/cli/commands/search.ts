import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { checkActiveSpace } from "../../embed/state.js";
import {
	RerankConfigurationError,
	type Reranker,
	selectReranker,
} from "../../rerank/provider.js";
import { embedQuery } from "../../search/embed-query.js";
import { type SearchHit, search, searchConcepts } from "../../search/search.js";
import { resolvePaths } from "../../utils/paths.js";
import { count, text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";

/** Concepts returned when `--limit` is not given. */
const DEFAULT_LIMIT = 10;
/** Passages shown per concept when `--chunks` is not given. */
const DEFAULT_CHUNKS_PER_CONCEPT = 2;
/** Neighbours added below the direct hits when `--expand` is not given. */
const DEFAULT_EXPAND = 3;
/** Fused hits a reranker reads when `--candidates` is not given. */
const DEFAULT_CANDIDATES = 20;

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
	let candidates: number;
	let reranker: Reranker | undefined;
	try {
		limit = count(context.flags.limit, DEFAULT_LIMIT, "--limit");
		candidates = count(
			context.flags.candidates,
			Math.max(DEFAULT_CANDIDATES, limit),
			"--candidates",
		);
		if (candidates < limit) {
			throw new Error(
				`--candidates must be at least --limit (${limit}), got: ${candidates}`,
			);
		}
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
		// A reranker that cannot be built is refused here, unlike an embedding
		// provider that cannot: a misconfigured reranker would otherwise weaken
		// every search and never say so.
		reranker = selectReranker(context.env);
	} catch (error) {
		return { code: 1, stderr: (error as Error).message };
	}

	const embedded = await embedQuery(
		context.positionals[0],
		context.env,
		context.report,
	);

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
		let result: Awaited<ReturnType<typeof ask>>;
		try {
			result = await ask(db, {
				query: context.positionals[0],
				limit,
				chunksPerConcept,
				asOf,
				expand,
				reranker,
				candidates,
				semantic: embedded.semantic,
				semanticUnavailable: embedded.reason,
				type: text(context.flags.type),
				tag: text(context.flags.tag),
				dir: text(context.flags.dir),
				status: text(context.flags.status),
				trust: text(context.flags.trust),
				includeDeprecated: context.flags["include-deprecated"] !== undefined,
			});
		} catch (error) {
			// The service rejecting the key is the same mistake as no key at all,
			// found one step later.
			if (error instanceof RerankConfigurationError) {
				return { code: 1, stderr: error.message };
			}
			throw error;
		}

		// A caller that would rather fail than be told the answer is weaker.
		if (result.degraded && context.flags["require-embeddings"] !== undefined) {
			return {
				code: 1,
				stderr:
					`--require-embeddings was given and the semantic leg could not run: ` +
					`${result.degradedReason}`,
			};
		}
		if (
			result.rerankReason !== undefined &&
			context.flags["require-rerank"] !== undefined
		) {
			return {
				code: 1,
				stderr:
					`--require-rerank was given and the reranker did not run: ` +
					`${result.rerankReason}`,
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
					reranked: result.reranked,
					rerank: result.rerank,
					rerankReason: result.rerankReason ?? null,
					hits: result.hits,
				})}\n`,
			};
		}

		return {
			code: 0,
			stdout:
				(result.degraded ? `Keyword-only: ${result.degradedReason}.\n\n` : "") +
				(result.rerankReason !== undefined
					? `Not reranked: ${result.rerankReason}.\n\n`
					: "") +
				render(result.hits),
		};
	} finally {
		db.close();
	}
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
