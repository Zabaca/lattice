/**
 * The runner's index and web legs, wired to one Lattice home.
 *
 * `lattice run` and `lattice research` search the same way: a query over
 * the index returns each hit's passages in full, a query over the web
 * returns each page's highlights, and a page the judge wants in full is
 * fetched and ranked. This is that wiring, built once from the command's
 * connection, provider and searcher, so the two commands cannot drift.
 */

import type { Database } from "bun:sqlite";
import type { EmbeddingProvider } from "../../embed/provider.js";
import { checkActiveSpace } from "../../embed/state.js";
import type { Candidate } from "../../run/judge.js";
import { passagesFor } from "../../run/read.js";
import type { RunnerDeps, RunResult } from "../../run/runner.js";
import { embedQueryWith } from "../../search/embed-query.js";
import { search } from "../../search/search.js";
import { MultiSearcher } from "../../web/multi.js";
import type { WebSearcher } from "../../web/provider.js";

/** Concepts one query pulls from the index. */
const INDEX_LIMIT = 5;
/** Passages read per concept. */
const CHUNKS_PER_CONCEPT = 2;
/** Pages one query pulls from the web. */
const WEB_LIMIT = 5;
/** The web leg every round searches when the environment names none. */
export const DEFAULT_WEB_LEGS = "exa";
/**
 * The legs added from the first rewrite on, when the environment names
 * none: Claude's own WebSearch, fifteen seconds and a few cents a query,
 * paid for only once Exa has failed to satisfy the judge.
 */
export const DEFAULT_WEB_ESCALATION = "claude";

export type SearchDeps = Pick<
	RunnerDeps,
	"searchIndex" | "searchWeb" | "readPage"
>;

/**
 * The three legs. `provider` is a thunk because selecting one can fail,
 * and that failure is the semantic leg's reason, not the command's;
 * callers memoise it so the model is loaded once.
 */
export function searchDeps(options: {
	db: Database;
	provider: () => EmbeddingProvider;
	web: WebSearcher | undefined;
	index: boolean;
}): SearchDeps {
	const { db, provider, web } = options;
	const passageText = db.prepare<{ content: string }, [string, number]>(
		`SELECT ch.content FROM chunks ch
		 JOIN concepts c ON c.id = ch.concept_id
		 WHERE c.path = ? AND ch.ordinal = ?`,
	);
	// The model that ranks a read page's passages is the same one the index
	// uses, when it can be had; without it the keyword leg ranks alone, as a
	// search without its semantic leg does.
	const embedder = () => {
		try {
			return provider();
		} catch {
			return undefined;
		}
	};
	return {
		searchIndex: options.index
			? async (query) => {
					const embedded = await embedQueryWith(query, provider);
					if (embedded.space !== undefined) {
						const mismatch = checkActiveSpace(
							db,
							embedded.space,
							embedded.source ?? "",
						);
						if (mismatch !== undefined) {
							throw new Error(mismatch);
						}
					}
					const result = await search(db, {
						query,
						limit: INDEX_LIMIT,
						chunksPerConcept: CHUNKS_PER_CONCEPT,
						asOf: Date.now(),
						expand: 0,
						candidates: INDEX_LIMIT,
						semantic: embedded.semantic,
						semanticUnavailable: embedded.reason,
					});
					// The judge and the skill read the passage itself, not the
					// 180-character window `search` shows: a snippet cut mid-sentence
					// reads as a gap that the document does not have.
					return result.hits.map(
						(hit): Candidate => ({
							source: "index",
							title: hit.title ?? hit.path,
							ref: hit.path,
							text: hit.chunks
								.map(
									(chunk) =>
										passageText.get(hit.path, chunk.ordinal)?.content ??
										chunk.snippet,
								)
								.join("\n\n"),
						}),
					);
				}
			: undefined,
		searchWeb:
			web === undefined
				? undefined
				: async (query, round) => {
						if (round > 0 && web instanceof MultiSearcher) {
							web.escalate();
						}
						const response = await web.search({
							query,
							type: "fast",
							limit: WEB_LIMIT,
							text: false,
						});
						return {
							candidates: response.results.map(
								(page): Candidate => ({
									source: "web",
									title: page.title ?? page.url,
									ref: page.url,
									text: page.highlights.join("\n"),
									...(page.leg === undefined ? {} : { leg: page.leg }),
								}),
							),
							costUsd: response.cost,
						};
					},
		readPage:
			web === undefined
				? undefined
				: async (question, url) => {
						const page = await web.read(url);
						return {
							passages: await passagesFor(question, page.text, embedder()),
							costUsd: page.cost,
						};
					},
	};
}

/** A provider selected on first use and kept; a selection that throws is retried on the next use. */
export function memoised(
	select: () => EmbeddingProvider,
): () => EmbeddingProvider {
	let provider: EmbeddingProvider | undefined;
	return () => {
		if (provider === undefined) {
			provider = select();
		}
		return provider;
	};
}

/**
 * Why the web was not fully searched, in one string: the loop's own reason,
 * a leg that never built, and the legs a `MultiSearcher` dropped, so a run
 * over Exa alone because Claude failed says so, and vice versa.
 */
export function webReasons(
	loop: Pick<RunResult, "webReason">,
	builderReason: string | undefined,
	web: WebSearcher | undefined,
): string | null {
	const reasons = [
		...(loop.webReason === null ? [] : [loop.webReason]),
		...(builderReason === undefined ? [] : [builderReason]),
		...(web instanceof MultiSearcher ? web.reasons() : []),
	];
	return reasons.length === 0 ? null : [...new Set(reasons)].join("; ");
}
