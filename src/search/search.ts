/**
 * Keyword search over chunks.
 *
 * Two things find a passage: the full-text index over chunk headings and
 * bodies, and the concept titles, which are frontmatter and so are not in the
 * full-text index at all. Both feed one scorer, which is tiered on purpose —
 * a title hit beats a heading hit beats a body hit, whatever the corpus
 * statistics say — and the results are then grouped so no single long
 * document can fill the page.
 */

import type { Database } from "bun:sqlite";
import {
	buildMatchExpression,
	extractTerms,
	type MatchMode,
	termCoverage,
} from "./query.js";

/**
 * Score tiers. The gaps are what make the ordering a property of the scorer:
 * a full body match plus the largest possible tiebreak still sits below one
 * heading match, and the same again below one title match.
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
/**
 * Passages one concept may contribute to that window, as a multiple of what
 * it can end up showing. Without this a single long document matching in
 * hundreds of places would fill the window and starve every other concept
 * before the grouping below ever ran.
 */
const CANDIDATES_PER_CONCEPT = 4;
/** Characters of chunk text shown around the first matching term. */
const SNIPPET_CHARS = 180;

export interface SearchFilters {
	type?: string;
	tag?: string;
	dir?: string;
	status?: string;
	trust?: string;
	/** Include concepts whose status is `deprecated`, which are otherwise left out. */
	includeDeprecated?: boolean;
}

export interface SearchOptions extends SearchFilters {
	query: string;
	/** Maximum concepts returned. */
	limit: number;
	/** Maximum chunks shown per concept. */
	chunksPerConcept: number;
	/** The instant staleness is judged against, as epoch milliseconds. */
	asOf: number;
}

export interface SearchChunk {
	ordinal: number;
	headingPath: string;
	startLine: number;
	endLine: number;
	startChar: number;
	endChar: number;
	snippet: string;
	score: number;
}

export interface SearchHit {
	path: string;
	identifier: string;
	title: string | null;
	type: string | null;
	status: string | null;
	trust: string;
	staleAfter: string | null;
	stale: boolean;
	score: number;
	chunks: SearchChunk[];
}

export interface SearchResult {
	/** The terms the query was reduced to; empty when it held no searchable text. */
	terms: string[];
	/** Which pass produced these hits, or undefined when nothing matched. */
	mode?: MatchMode;
	hits: SearchHit[];
}

interface CandidateRow {
	chunk_id: number;
	concept_id: number;
	ordinal: number;
	heading_path: string | null;
	start_line: number;
	end_line: number;
	start_char: number;
	end_char: number;
	content: string;
	path: string;
	identifier: string;
	title: string | null;
	type: string | null;
	status: string | null;
	trust: string;
	stale_after: string | null;
	bm: number | null;
}

/** The concept columns every candidate carries, so one row is a whole hit. */
const CONCEPT_COLUMNS = `c.path, c.identifier, c.title, c.type, c.status, c.trust, c.stale_after`;
const CHUNK_COLUMNS = `ch.id AS chunk_id, ch.concept_id, ch.ordinal, ch.heading_path,
	ch.start_line, ch.end_line, ch.start_char, ch.end_char, ch.content`;

export function search(db: Database, options: SearchOptions): SearchResult {
	const terms = extractTerms(options.query);
	if (terms.length === 0) {
		return { terms, hits: [] };
	}

	for (const mode of ["all", "any"] as const) {
		const rows = [
			...fullTextCandidates(db, terms, mode, options),
			...titleCandidates(db, terms, mode, options),
		];
		if (rows.length === 0) {
			continue;
		}
		return { terms, mode, hits: group(rows, terms, options) };
	}

	return { terms, hits: [] };
}

/** The `WHERE` fragments and bound values every candidate query shares. */
function conceptFilters(filters: SearchFilters): {
	sql: string;
	values: string[];
} {
	const clauses: string[] = [];
	const values: string[] = [];

	if (filters.type !== undefined) {
		clauses.push("c.type = ?");
		values.push(filters.type);
	}
	if (filters.status !== undefined) {
		clauses.push("c.status = ?");
		values.push(filters.status);
	}
	if (filters.trust !== undefined) {
		clauses.push("c.trust = ?");
		values.push(filters.trust);
	}
	if (filters.dir !== undefined) {
		// A directory filter covers the directory itself and everything under it.
		clauses.push("(c.dir = ? OR c.dir LIKE ? || '/%')");
		values.push(filters.dir, filters.dir);
	}
	if (filters.tag !== undefined) {
		clauses.push(
			"EXISTS (SELECT 1 FROM tags t WHERE t.concept_id = c.id AND t.tag = ?)",
		);
		values.push(filters.tag);
	}
	// A deprecated concept is retired, not deleted: it stays out of the way
	// unless it is the thing being asked for.
	if (filters.includeDeprecated !== true && filters.status === undefined) {
		clauses.push("(c.status IS NULL OR c.status <> 'deprecated')");
	}

	return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), values };
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
 * Score every candidate passage, then fold them into one entry per concept.
 *
 * A concept's score is its best passage's, so a document is ranked by the
 * strongest answer it holds rather than by how many times it repeats itself.
 */
function group(
	rows: CandidateRow[],
	terms: string[],
	options: SearchOptions,
): SearchHit[] {
	const hits = new Map<number, SearchHit>();
	const seenChunks = new Set<number>();

	for (const row of rows) {
		if (seenChunks.has(row.chunk_id)) {
			continue;
		}
		seenChunks.add(row.chunk_id);

		const stale = isStale(row.stale_after, options.asOf);
		const score = scoreChunk(row, terms, stale);
		if (score <= 0) {
			continue;
		}

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

	return [...hits.values()]
		.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
		.slice(0, options.limit);
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

/** A concept is stale once its `stale_after` is behind the instant asked about. */
function isStale(staleAfter: string | null, asOf: number): boolean {
	if (staleAfter === null) {
		return false;
	}
	const at = Date.parse(staleAfter);
	return Number.isNaN(at) ? false : at < asOf;
}

/**
 * A window of the passage around its first matching term, so the line shown
 * is the line that matched rather than the top of the section.
 */
function snippetOf(content: string, terms: string[]): string {
	const flat = content.replaceAll(/\s+/g, " ").trim();
	const haystack = flat.toLowerCase();

	let at = -1;
	for (const term of terms) {
		const found = haystack.indexOf(term);
		if (found !== -1 && (at === -1 || found < at)) {
			at = found;
		}
	}

	if (flat.length <= SNIPPET_CHARS) {
		return flat;
	}

	const start = Math.max(0, (at === -1 ? 0 : at) - SNIPPET_CHARS / 4);
	const end = Math.min(flat.length, start + SNIPPET_CHARS);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
