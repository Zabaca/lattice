/**
 * One hop out from the answers.
 *
 * A retrieval engine that returns only what matched returns only what the
 * asker already knew how to ask for. The documents an author linked to, the
 * documents that cite them, and the documents filed beside them are the
 * author's own statement that these things belong together — a statement made
 * before anyone asked this question, which is what makes it worth following.
 *
 * Expansion is bounded on purpose. It goes one hop, it is capped, it never
 * returns something already among the answers, and a neighbour always ranks
 * below every direct hit: related material is context, not an answer, and the
 * moment it outranks one the search has started answering a question nobody
 * asked.
 */

import type { Database } from "bun:sqlite";
import { conceptFilters, type SearchFilters } from "./filters.js";
import { extractTerms } from "./query.js";
import {
	type CandidateRow,
	CHUNK_COLUMNS,
	CONCEPT_COLUMNS,
	isStale,
	type Relation,
	type SearchHit,
	snippetOf,
} from "./rows.js";
import { cosine, fromBlob, type SemanticInput } from "./vector.js";

/** Direct hits whose neighbourhood is walked. Beyond this, relevance is thin. */
const EXPANSION_SOURCES = 3;

export interface ExpansionOptions extends SearchFilters {
	/** Neighbours to add at most. Zero turns expansion off. */
	expand: number;
	asOf: number;
	semantic?: SemanticInput;
	query: string;
}

interface NeighbourRow {
	concept_id: number;
	source_id: number;
	relation: Relation;
}

/**
 * The neighbours of the top direct hits, as hits of their own.
 *
 * `direct` is the ranked answer list; `conceptIds` are its concept ids in the
 * same order, because a hit carries a path rather than an id.
 */
export function expand(
	db: Database,
	direct: SearchHit[],
	conceptIds: number[],
	options: ExpansionOptions,
): SearchHit[] {
	if (options.expand <= 0 || direct.length === 0) {
		return [];
	}

	const sources = conceptIds.slice(0, EXPANSION_SOURCES);
	const sourcePath = new Map(
		conceptIds.map((id, index) => [id, direct[index].path]),
	);
	const already = new Set(conceptIds);

	const chosen: NeighbourRow[] = [];
	const taken = new Set<number>();
	// Relation order is the order of the author's own claim: an explicit link
	// says more than sharing a directory, and both are taken before the cap.
	for (const relation of ["link", "backlink", "sibling"] as const) {
		for (const row of neighbours(db, sources, relation, options)) {
			if (already.has(row.concept_id) || taken.has(row.concept_id)) {
				continue;
			}
			taken.add(row.concept_id);
			chosen.push(row);
			if (chosen.length >= options.expand) {
				break;
			}
		}
		if (chosen.length >= options.expand) {
			break;
		}
	}

	if (chosen.length === 0) {
		return [];
	}

	const passages = bestPassages(
		db,
		chosen.map((row) => row.concept_id),
		options,
	);

	// Every neighbour sits below the weakest answer, in a descending band of
	// its own, so position and score never disagree.
	const floor = Math.min(...direct.map((hit) => hit.score));
	const step = floor / (chosen.length + 1);
	const terms = extractTerms(options.query);

	const hits: SearchHit[] = [];
	chosen.forEach((row, index) => {
		const passage = passages.get(row.concept_id);
		if (passage === undefined) {
			return;
		}
		const score = floor - step * (index + 1);
		hits.push({
			path: passage.path,
			identifier: passage.identifier,
			title: passage.title,
			type: passage.type,
			status: passage.status,
			trust: passage.trust,
			staleAfter: passage.stale_after,
			stale: isStale(passage.stale_after, options.asOf),
			score,
			expanded: true,
			via: {
				relation: row.relation,
				from: sourcePath.get(row.source_id) ?? "",
			},
			chunks: [
				{
					ordinal: passage.ordinal,
					headingPath: passage.heading_path ?? "",
					startLine: passage.start_line,
					endLine: passage.end_line,
					startChar: passage.start_char,
					endChar: passage.end_char,
					snippet: snippetOf(passage.content, terms),
					score,
				},
			],
		});
	});

	return hits;
}

/**
 * The concepts one relation reaches from a set of sources, ordered by how
 * highly the source that reached them was ranked.
 *
 * An unresolved link — a target the author named but nobody has written —
 * has no concept to return, and a document is never its own neighbour.
 */
function neighbours(
	db: Database,
	sources: number[],
	relation: Relation,
	filters: SearchFilters,
): NeighbourRow[] {
	if (sources.length === 0) {
		return [];
	}
	const placeholders = sources.map(() => "?").join(", ");
	const bounds = conceptFilters(filters);
	const order = `CASE c.id ${sources.map((_, index) => `WHEN ? THEN ${index}`).join(" ")} ELSE ${sources.length} END`;

	// The source ids are bound twice: once to select the edge, once to order
	// the results by the rank of the source that reached them.
	if (relation === "sibling") {
		return db
			.query<NeighbourRow, (string | number)[]>(
				`SELECT DISTINCT c.id AS concept_id, source.id AS source_id, 'sibling' AS relation
				FROM concepts source
				JOIN concepts c ON c.dir = source.dir AND c.id <> source.id
				WHERE source.id IN (${placeholders})${bounds.sql}
				ORDER BY ${order.replaceAll("c.id", "source.id")}, c.path`,
			)
			.all(...sources, ...bounds.values, ...sources);
	}

	const [from, to] =
		relation === "link"
			? ["source_concept_id", "target_concept_id"]
			: ["target_concept_id", "source_concept_id"];

	return db
		.query<NeighbourRow, (string | number)[]>(
			`SELECT DISTINCT c.id AS concept_id, l.${from} AS source_id, '${relation}' AS relation
			FROM links l
			JOIN concepts c ON c.id = l.${to}
			WHERE l.${from} IN (${placeholders}) AND l.${to} IS NOT NULL
				AND l.${to} <> l.${from}${bounds.sql}
			ORDER BY ${order.replaceAll("c.id", `l.${from}`)}, c.path`,
		)
		.all(...sources, ...bounds.values, ...sources);
}

/**
 * The passage that best represents each neighbour.
 *
 * With a query vector that is the nearest passage, which is the whole reason
 * to expand at passage level rather than just naming the document. Without
 * one it is the document's opening, which is the only honest default.
 */
function bestPassages(
	db: Database,
	conceptIds: number[],
	options: ExpansionOptions,
): Map<number, CandidateRow> {
	const placeholders = conceptIds.map(() => "?").join(", ");
	const rows = db
		.query<CandidateRow, number[]>(
			`SELECT ${CHUNK_COLUMNS}, ${CONCEPT_COLUMNS}, NULL AS bm
			FROM chunks ch
			JOIN concepts c ON c.id = ch.concept_id
			WHERE ch.concept_id IN (${placeholders})
			ORDER BY ch.concept_id, ch.ordinal`,
		)
		.all(...conceptIds);

	const best = new Map<number, CandidateRow>();
	const scores = new Map<number, number>();
	const similarities =
		options.semantic === undefined
			? new Map<number, number>()
			: chunkSimilarities(db, options.semantic, conceptIds);

	for (const row of rows) {
		const similarity = similarities.get(row.chunk_id) ?? 0;
		const current = scores.get(row.concept_id);
		// Ties keep the earlier passage, which `ORDER BY ordinal` makes the
		// opening one.
		if (current === undefined || similarity > current) {
			scores.set(row.concept_id, similarity);
			best.set(row.concept_id, row);
		}
	}

	return best;
}

function chunkSimilarities(
	db: Database,
	semantic: SemanticInput,
	conceptIds: number[],
): Map<number, number> {
	const placeholders = conceptIds.map(() => "?").join(", ");
	const rows = db
		.query<
			{ chunk_id: number; dim: number; vector: Uint8Array },
			[string, ...number[]]
		>(
			`SELECT e.chunk_id, e.dim, e.vector
			FROM chunk_embeddings e
			JOIN chunks ch ON ch.id = e.chunk_id
			WHERE e.model = ? AND ch.concept_id IN (${placeholders})`,
		)
		.all(semantic.model, ...conceptIds);

	const similarities = new Map<number, number>();
	for (const row of rows) {
		if (row.dim !== semantic.vector.length) {
			continue;
		}
		similarities.set(
			row.chunk_id,
			cosine(semantic.vector, fromBlob(row.vector, row.dim)),
		);
	}
	return similarities;
}
