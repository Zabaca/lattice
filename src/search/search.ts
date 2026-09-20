/**
 * Hybrid search over chunks.
 *
 * Two legs run over the same filtered candidate set. The keyword leg is the
 * full-text index over chunk headings and bodies plus the concept titles,
 * which are frontmatter and so are not in the full-text index at all; it is
 * tiered on purpose — a title hit beats a heading hit beats a body hit,
 * whatever the corpus statistics say. The semantic leg is a cosine scan over
 * the stored chunk vectors. Neither leg's scores are comparable with the
 * other's, so the two are fused by rank rather than by value, and a passage
 * either leg ranked highly survives.
 *
 * The concept's own vector is then allowed to break ties between passages and
 * nothing more — it says which document is about the question, which is a
 * weaker claim than which passage answers it.
 *
 * Results are grouped so no single long document can fill the page.
 */

import type { Database } from "bun:sqlite";
import { expand } from "./expand.js";
import { conceptFilters, type SearchFilters } from "./filters.js";
import { reciprocalRankFusion, tiebreakEpsilon } from "./fuse.js";
import {
	buildMatchExpression,
	extractTerms,
	type MatchMode,
	termCoverage,
} from "./query.js";
import {
	type CandidateRow,
	CHUNK_COLUMNS,
	CONCEPT_COLUMNS,
	chunkRows,
	isStale,
	type SearchChunk,
	type SearchHit,
	snippetOf,
} from "./rows.js";
import {
	conceptSimilarities,
	hasEmbeddings,
	type SemanticInput,
	vectorCandidates,
} from "./vector.js";

export type { SearchFilters } from "./filters.js";
export type { SearchChunk, SearchHit } from "./rows.js";

/**
 * Score tiers for the keyword leg. The gaps are what make the ordering a
 * property of the scorer: a full body match plus the largest possible tiebreak
 * still sits below one heading match, and the same again below one title match.
 */
const TITLE_WEIGHT = 100;
const HEADING_WEIGHT = 10;
const BODY_WEIGHT = 1;
/** BM25's share, squashed into [0, 1) so it can only ever break a tie within a tier. */
const RELEVANCE_WEIGHT = 0.9;
/** What is left of a concept's score once it is past its staleness date. */
const STALE_FACTOR = 0.5;
/** BM25 column weights, in the order `chunks_fts` declares: heading_path, content. */
const BM25_HEADING = 5;
const BM25_CONTENT = 1;
/** Rows pulled from one full-text pass before grouping. */
const CANDIDATE_LIMIT = 500;
/** Passages the semantic leg contributes to the fusion. */
const VECTOR_LIMIT = 200;
/**
 * Passages one concept may contribute to that window, as a multiple of what
 * it can end up showing. Without this a single long document matching in
 * hundreds of places would fill the window and starve every other concept
 * before the grouping below ever ran.
 */
const CANDIDATES_PER_CONCEPT = 4;

export interface SearchOptions extends SearchFilters {
	query: string;
	/** Maximum concepts returned. */
	limit: number;
	/** Maximum chunks shown per concept. */
	chunksPerConcept: number;
	/** The instant staleness is judged against, as epoch milliseconds. */
	asOf: number;
	/** The embedded query, when there is one. */
	semantic?: SemanticInput;
	/** Why there is no embedded query, when there is not. */
	semanticUnavailable?: string;
	/** Neighbours of the top hits to add below them. Zero turns expansion off. */
	expand: number;
}

export interface SearchResult {
	/** The terms the query was reduced to; empty when it held no searchable text. */
	terms: string[];
	/** Which keyword pass produced candidates, or undefined when none did. */
	mode?: MatchMode;
	/** True when the semantic leg could not run at all, so this is keyword-only. */
	degraded: boolean;
	/** Why, when it is degraded. */
	degradedReason?: string;
	/** Direct hits first, then whatever expansion reached from them. */
	hits: SearchHit[];
}

export function search(db: Database, options: SearchOptions): SearchResult {
	const terms = extractTerms(options.query);
	const semantic = usableSemantic(db, options);

	const keyword = keywordLeg(db, terms, options);
	const vector =
		semantic.input === undefined
			? []
			: vectorCandidates(db, semantic.input, options, VECTOR_LIMIT);

	const rows = collectRows(db, keyword.rows, vector);
	if (rows.size === 0) {
		return {
			terms,
			mode: keyword.mode,
			degraded: semantic.degraded,
			degradedReason: semantic.reason,
			hits: [],
		};
	}

	const scored = fuse(db, rows, keyword, vector, semantic.input, options);
	const direct = group(rows, scored, options);

	return {
		terms,
		mode: keyword.mode,
		degraded: semantic.degraded,
		degradedReason: semantic.reason,
		hits: [
			...direct.map((entry) => entry.hit),
			...expand(
				db,
				direct.map((entry) => entry.hit),
				direct.map((entry) => entry.conceptId),
				{ ...options, semantic: semantic.input },
			),
		],
	};
}

/**
 * The same question asked of documents instead of passages.
 *
 * "Which document is about this" is a different question from "which passage
 * answers this", and the index holds a different signal for it: the concept
 * vector, built from what a document calls itself and says it is about. Here
 * that vector is a ranked leg in its own right — which is exactly what it is
 * never allowed to be in passage search, where it can only settle ties.
 *
 * The keyword leg is the same one, read at document level: a document's
 * keyword standing is that of its best passage.
 */
export function searchConcepts(
	db: Database,
	options: SearchOptions,
): SearchResult {
	const terms = extractTerms(options.query);
	const semantic = usableSemantic(db, options);
	const keyword = keywordLeg(db, terms, options);

	const bestPassage = new Map<number, number>();
	for (const row of keyword.rows) {
		const score = keyword.scores.get(row.chunk_id) ?? 0;
		if (score > (bestPassage.get(row.concept_id) ?? Number.NEGATIVE_INFINITY)) {
			bestPassage.set(row.concept_id, score);
		}
	}

	const similarities =
		semantic.input === undefined
			? new Map<number, number>()
			: conceptSimilarities(db, semantic.input, options);

	const fused = reciprocalRankFusion([
		byDescendingScore(bestPassage),
		byDescendingScore(similarities),
	]);

	const rows = conceptRows(db, [...fused.keys()]);
	const direct: { hit: SearchHit; conceptId: number }[] = [];
	for (const [conceptId, fusedScore] of fused) {
		const row = rows.get(conceptId);
		if (row === undefined) {
			continue;
		}
		const stale = isStale(row.stale_after, options.asOf);
		direct.push({
			conceptId,
			hit: {
				path: row.path,
				identifier: row.identifier,
				title: row.title,
				type: row.type,
				status: row.status,
				trust: row.trust,
				staleAfter: row.stale_after,
				stale,
				score: stale ? fusedScore * STALE_FACTOR : fusedScore,
				chunks: [],
			},
		});
	}

	direct.sort(
		(a, b) => b.hit.score - a.hit.score || (a.hit.path < b.hit.path ? -1 : 1),
	);
	const limited = direct.slice(0, options.limit);

	// A neighbour is a document here too, so it arrives without its passage.
	const expanded = expand(
		db,
		limited.map((entry) => entry.hit),
		limited.map((entry) => entry.conceptId),
		{ ...options, semantic: semantic.input },
	).map((hit) => ({ ...hit, chunks: [] }));

	return {
		terms,
		mode: keyword.mode,
		degraded: semantic.degraded,
		degradedReason: semantic.reason,
		hits: [...limited.map((entry) => entry.hit), ...expanded],
	};
}

/** Ids best first, by a score each of them has. */
function byDescendingScore(scores: Map<number, number>): number[] {
	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.map(([id]) => id);
}

interface ConceptRow {
	id: number;
	path: string;
	identifier: string;
	title: string | null;
	type: string | null;
	status: string | null;
	trust: string;
	stale_after: string | null;
}

function conceptRows(
	db: Database,
	conceptIds: number[],
): Map<number, ConceptRow> {
	if (conceptIds.length === 0) {
		return new Map();
	}
	const placeholders = conceptIds.map(() => "?").join(", ");
	const rows = db
		.query<ConceptRow, number[]>(
			`SELECT c.id, ${CONCEPT_COLUMNS} FROM concepts c WHERE c.id IN (${placeholders})`,
		)
		.all(...conceptIds);
	return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Whether the semantic leg can run, and what to tell the caller when it cannot.
 *
 * A model that embedded the query but never embedded the corpus is as useless
 * as no model at all, and a corpus embedded by a DIFFERENT model is worse than
 * useless — the numbers would be comparable only by accident. Both are
 * degradation, and both are said out loud.
 */
function usableSemantic(
	db: Database,
	options: SearchOptions,
): { input?: SemanticInput; degraded: boolean; reason?: string } {
	if (options.semantic === undefined) {
		return {
			degraded: true,
			reason:
				options.semanticUnavailable ?? "no embedding provider is available",
		};
	}
	if (!hasEmbeddings(db, options.semantic.model)) {
		return {
			degraded: true,
			reason: `nothing in the index is embedded with ${options.semantic.model}; run \`lattice embed\``,
		};
	}
	return { input: options.semantic, degraded: false };
}

interface KeywordLeg {
	rows: CandidateRow[];
	mode?: MatchMode;
	/** Chunk ids best first, by the tiered keyword score. */
	ranking: number[];
	/** The tiered score of each chunk, so grouping can keep the stale penalty. */
	scores: Map<number, number>;
}

/**
 * The keyword leg: the precise pass, then the broad one.
 *
 * `all` is tried first because it is the precise answer; `any` is the retry
 * that turns a question with no exact answer into candidates.
 */
function keywordLeg(
	db: Database,
	terms: string[],
	options: SearchOptions,
): KeywordLeg {
	if (terms.length === 0) {
		return { rows: [], ranking: [], scores: new Map() };
	}

	for (const mode of ["all", "any"] as const) {
		const rows = [
			...fullTextCandidates(db, terms, mode, options),
			...titleCandidates(db, terms, mode, options),
		];
		if (rows.length === 0) {
			continue;
		}

		const seen = new Set<number>();
		const scores = new Map<number, number>();
		const unique: CandidateRow[] = [];
		for (const row of rows) {
			if (seen.has(row.chunk_id)) {
				continue;
			}
			seen.add(row.chunk_id);
			const score = scoreChunk(
				row,
				terms,
				isStale(row.stale_after, options.asOf),
			);
			if (score <= 0) {
				continue;
			}
			scores.set(row.chunk_id, score);
			unique.push(row);
		}

		const ranking = [...scores.entries()]
			.sort((a, b) => b[1] - a[1] || a[0] - b[0])
			.map(([chunkId]) => chunkId);

		return { rows: unique, mode, ranking, scores };
	}

	return { rows: [], ranking: [], scores: new Map() };
}

/**
 * Every candidate passage as a whole row.
 *
 * The keyword leg already carries its rows; the semantic leg carries only ids,
 * because its scan reads vectors and must not drag the corpus text through
 * memory. The handful of passages it chose are fetched here.
 */
function collectRows(
	db: Database,
	keywordRows: CandidateRow[],
	vector: { chunkId: number }[],
): Map<number, CandidateRow> {
	const rows = new Map<number, CandidateRow>();
	for (const row of keywordRows) {
		rows.set(row.chunk_id, row);
	}

	const missing = vector
		.map((candidate) => candidate.chunkId)
		.filter((chunkId) => !rows.has(chunkId));
	for (const row of chunkRows(db, missing)) {
		rows.set(row.chunk_id, row);
	}

	return rows;
}

/**
 * One score per passage: the rank fusion of the two legs, demoted if the
 * concept is stale, nudged by the concept's own vector to settle ties.
 */
function fuse(
	db: Database,
	rows: Map<number, CandidateRow>,
	keyword: KeywordLeg,
	vector: { chunkId: number }[],
	semantic: SemanticInput | undefined,
	options: SearchOptions,
): Map<number, number> {
	const fused = reciprocalRankFusion([
		keyword.ranking,
		vector.map((candidate) => candidate.chunkId),
	]);

	const stalePenalty = new Map<number, number>();
	for (const [chunkId, score] of fused) {
		const row = rows.get(chunkId);
		const stale = row !== undefined && isStale(row.stale_after, options.asOf);
		stalePenalty.set(chunkId, stale ? score * STALE_FACTOR : score);
	}

	if (semantic === undefined) {
		return stalePenalty;
	}

	// The concept vector is a tiebreak and nothing else: the nudge is sized so
	// it can close a gap of zero and never cross a gap that is not.
	const epsilon = tiebreakEpsilon(stalePenalty.values());
	const similarities = conceptSimilarities(db, semantic, options);

	const settled = new Map<number, number>();
	for (const [chunkId, score] of stalePenalty) {
		const row = rows.get(chunkId);
		const similarity =
			row === undefined ? 0 : (similarities.get(row.concept_id) ?? 0);
		settled.set(chunkId, score + epsilon * Math.max(similarity, 0));
	}
	return settled;
}

function fullTextCandidates(
	db: Database,
	terms: string[],
	mode: MatchMode,
	options: SearchOptions,
): CandidateRow[] {
	const expression = buildMatchExpression(terms, mode);
	if (expression === undefined) {
		return [];
	}
	const filters = conceptFilters(options);

	const perConcept = Math.max(
		options.chunksPerConcept * CANDIDATES_PER_CONCEPT,
		CANDIDATES_PER_CONCEPT,
	);

	return db
		.query<CandidateRow, [string, ...string[], number, number]>(
			// bm25() is only callable directly against the MATCH, so it is
			// computed innermost and every layer above works on the value.
			`SELECT * FROM (
				SELECT *, row_number() OVER (
					PARTITION BY concept_id ORDER BY bm
				) AS rank_in_concept
				FROM (
					SELECT ${CHUNK_COLUMNS}, ${CONCEPT_COLUMNS},
						bm25(chunks_fts, ${BM25_HEADING}, ${BM25_CONTENT}) AS bm
					FROM chunks_fts
					JOIN chunks ch ON ch.id = chunks_fts.rowid
					JOIN concepts c ON c.id = ch.concept_id
					WHERE chunks_fts MATCH ?${filters.sql}
				)
			)
			WHERE rank_in_concept <= ?
			ORDER BY bm
			LIMIT ?`,
		)
		.all(expression, ...filters.values, perConcept, CANDIDATE_LIMIT);
}

/**
 * Concepts whose title matches, represented by their opening passage.
 *
 * Titles live in frontmatter and so are absent from the full-text index; a
 * document named after the thing being searched for would otherwise be
 * missed entirely when its body never repeats its own name.
 */
function titleCandidates(
	db: Database,
	terms: string[],
	mode: MatchMode,
	options: SearchOptions,
): CandidateRow[] {
	const filters = conceptFilters(options);
	const matches = terms.map(() => "instr(lower(c.title), ?) > 0");
	const joined = matches.join(mode === "all" ? " AND " : " OR ");

	return db
		.query<CandidateRow, [...string[], number]>(
			`SELECT ${CHUNK_COLUMNS}, ${CONCEPT_COLUMNS}, NULL AS bm
			FROM concepts c
			JOIN chunks ch ON ch.concept_id = c.id AND ch.ordinal = 0
			WHERE c.title IS NOT NULL AND (${joined})${filters.sql}
			LIMIT ?`,
		)
		.all(...terms, ...filters.values, CANDIDATE_LIMIT);
}

/**
 * Fold the scored passages into one entry per concept.
 *
 * A concept's score is its best passage's, so a document is ranked by the
 * strongest answer it holds rather than by how many times it repeats itself.
 */
function group(
	rows: Map<number, CandidateRow>,
	scores: Map<number, number>,
	options: SearchOptions,
): { hit: SearchHit; conceptId: number }[] {
	const terms = extractTerms(options.query);
	const hits = new Map<number, SearchHit>();

	for (const [chunkId, score] of scores) {
		const row = rows.get(chunkId);
		if (row === undefined || score <= 0) {
			continue;
		}

		const stale = isStale(row.stale_after, options.asOf);
		const chunk: SearchChunk = {
			ordinal: row.ordinal,
			headingPath: row.heading_path ?? "",
			startLine: row.start_line,
			endLine: row.end_line,
			startChar: row.start_char,
			endChar: row.end_char,
			snippet: snippetOf(row.content, terms),
			score,
		};

		const hit = hits.get(row.concept_id);
		if (hit === undefined) {
			hits.set(row.concept_id, {
				path: row.path,
				identifier: row.identifier,
				title: row.title,
				type: row.type,
				status: row.status,
				trust: row.trust,
				staleAfter: row.stale_after,
				stale,
				score,
				chunks: [chunk],
			});
			continue;
		}
		hit.chunks.push(chunk);
		hit.score = Math.max(hit.score, score);
	}

	for (const hit of hits.values()) {
		hit.chunks.sort(byScoreThenOrdinal);
		hit.chunks = hit.chunks.slice(0, options.chunksPerConcept);
	}

	return [...hits.entries()]
		.sort(([, a], [, b]) => b.score - a.score || (a.path < b.path ? -1 : 1))
		.slice(0, options.limit)
		.map(([conceptId, hit]) => ({ hit, conceptId }));
}

function byScoreThenOrdinal(a: SearchChunk, b: SearchChunk): number {
	return b.score - a.score || a.ordinal - b.ordinal;
}

/**
 * Where a passage matched decides its tier; BM25 only orders passages within
 * one. A stale concept keeps its tier but loses half its score, so it falls
 * behind an otherwise equal fresh one without disappearing.
 */
function scoreChunk(
	row: CandidateRow,
	terms: string[],
	stale: boolean,
): number {
	// BM25 is negative, and more negative means a better match.
	const relevance = row.bm === null ? 0 : -row.bm;
	const score =
		TITLE_WEIGHT * termCoverage(terms, row.title) +
		HEADING_WEIGHT * termCoverage(terms, row.heading_path) +
		BODY_WEIGHT * termCoverage(terms, row.content) +
		RELEVANCE_WEIGHT * (relevance / (1 + relevance));

	return stale ? score * STALE_FACTOR : score;
}
