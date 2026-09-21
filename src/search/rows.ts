/**
 * What a result is made of.
 *
 * A candidate is one passage carrying its concept's columns, so a single row
 * is a whole answer and no leg has to go back to the database to describe what
 * it found. The keyword leg, the semantic leg and graph expansion all produce
 * these, which is what lets them be compared at all.
 */

import type { Database } from "bun:sqlite";

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

/** How a result was reached when it was not matched directly. */
export type Relation = "link" | "backlink";

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
	/** Present only on a hit reached by expansion rather than by matching. */
	expanded?: true;
	/** Which answer it hangs off, and how. */
	via?: { relation: Relation; from: string };
	chunks: SearchChunk[];
}

export interface CandidateRow {
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
export const CONCEPT_COLUMNS = `c.path, c.identifier, c.title, c.type, c.status, c.trust, c.stale_after`;
export const CHUNK_COLUMNS = `ch.id AS chunk_id, ch.concept_id, ch.ordinal, ch.heading_path,
	ch.start_line, ch.end_line, ch.start_char, ch.end_char, ch.content`;

/** Whole rows for a set of chunk ids, in no particular order. */
export function chunkRows(db: Database, chunkIds: number[]): CandidateRow[] {
	if (chunkIds.length === 0) {
		return [];
	}
	const placeholders = chunkIds.map(() => "?").join(", ");
	return db
		.query<CandidateRow, number[]>(
			`SELECT ${CHUNK_COLUMNS}, ${CONCEPT_COLUMNS}, NULL AS bm
			FROM chunks ch
			JOIN concepts c ON c.id = ch.concept_id
			WHERE ch.id IN (${placeholders})`,
		)
		.all(...chunkIds);
}

/** A concept is stale once its `stale_after` is behind the instant asked about. */
export function isStale(staleAfter: string | null, asOf: number): boolean {
	if (staleAfter === null) {
		return false;
	}
	const at = Date.parse(staleAfter);
	return Number.isNaN(at) ? false : at < asOf;
}

/** Characters of chunk text shown around the first matching term. */
const SNIPPET_CHARS = 180;

/**
 * A window of the passage around its first matching term, so the line shown
 * is the line that matched rather than the top of the section.
 */
export function snippetOf(content: string, terms: string[]): string {
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
