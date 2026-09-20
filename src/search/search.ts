/**
 * Keyword search over chunks.
 *
 * FTS5 finds the candidate passages and BM25 orders them by how well the words
 * matched. Everything on top of that is about what the person asking actually
 * wanted: a hit in a document's title means more than one in a heading, which
 * means more than one buried in body text; a document nobody has revisited
 * since its staleness date sinks; and no single long document is allowed to
 * fill the page, so results are grouped by concept with a hard cap on the
 * passages each one contributes.
 */

import type { Database } from "bun:sqlite";
import { buildMatchExpression, queryTokens } from "./query.js";

/** Where a query's words were found. Higher means the author named it, not just mentioned it. */
export const TIER_BODY = 0;
export const TIER_HEADING = 1;
export const TIER_TITLE = 2;

/**
 * How far apart the tiers are on the score scale. BM25 is normalised into
 * [0, 1) below, so a tier always outranks the tier beneath it however strong
 * the weaker match was — which is the ordering the tiers exist to express.
 */
const TIER_WEIGHT = 10;

/**
 * What being past `stale_after` costs. Less than a tier, so a stale title
 * match still beats a fresh heading match, and more than any BM25 score, so a
 * stale passage always sits below its fresh equivalent.
 */
const STALE_PENALTY = 5;

/** BM25 column weights: the heading path is short, so a hit in it counts for more. */
const HEADING_WEIGHT = 5;
const CONTENT_WEIGHT = 1;

/** Characters of passage text returned with each hit. */
const SNIPPET_CHARS = 280;

/**
 * Candidate passages pulled from FTS before grouping. Generous, because the
 * per-concept cap can discard many rows from one document, and cheap, because
 * BM25 has already ordered them.
 */
const CANDIDATE_MULTIPLE = 40;
const MIN_CANDIDATES = 200;

export interface SearchOptions {
	query: string;
	/** Maximum concepts returned. */
	limit: number;
	/** Maximum passages returned per concept. */
	chunksPerConcept: number;
	types?: string[];
	tags?: string[];
	dirs?: string[];
	statuses?: string[];
	trusts?: string[];
	/** Include concepts whose status is `deprecated`. */
	includeDeprecated?: boolean;
	/** The instant staleness is judged against. */
	now?: Date;
}

export interface SearchChunk {
	ordinal: number;
	heading?: string;
	headingPath: string;
	startLine: number;
	endLine: number;
	startChar: number;
	endChar: number;
	snippet: string;
	score: number;
	/** Where this passage's match was found: body, heading or title. */
	tier: number;
}

export interface SearchResult {
	path: string;
	identifier: string;
	title?: string;
	type?: string;
	status?: string;
	trust: string;
	/** True when the concept is past its `stale_after` date. */
	stale: boolean;
	staleAfter?: string;
	/** The concept's score: that of its best passage. */
	score: number;
	chunks: SearchChunk[];
}

interface CandidateRow {
	concept_id: number;
	ordinal: number;
	heading: string | null;
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
	rank: number;
}

/**
 * Search the index. Returns an empty list — never an error — when the query
 * holds no searchable words or nothing matched.
 */
export function search(db: Database, options: SearchOptions): SearchResult[] {
	const match = buildMatchExpression(options.query);
	if (match === undefined) {
		return [];
	}

	const now = options.now ?? new Date();
	const tokens = queryTokens(options.query);
	// FTS covers headings and body text; titles live in the concept row, so
	// they are looked up separately and merged in.
	const rows = mergeCandidates(
		selectCandidates(db, match, options),
		selectTitleMatches(db, tokens, options),
	);

	const byConcept = new Map<number, SearchResult>();
	for (const row of rows) {
		const stale = isStale(row.stale_after, now);
		const tier = tierOf(row, tokens);
		const score = scoreOf(tier, row.rank, stale);

		const chunk: SearchChunk = {
			ordinal: row.ordinal,
			heading: row.heading ?? undefined,
			headingPath: row.heading_path ?? "",
			startLine: row.start_line,
			endLine: row.end_line,
			startChar: row.start_char,
			endChar: row.end_char,
			snippet: snippetOf(row.content, tokens),
			score,
			tier,
		};

		const existing = byConcept.get(row.concept_id);
		if (existing === undefined) {
			byConcept.set(row.concept_id, {
				path: row.path,
				identifier: row.identifier,
				title: row.title ?? undefined,
				type: row.type ?? undefined,
				status: row.status ?? undefined,
				trust: row.trust,
				stale,
				staleAfter: row.stale_after ?? undefined,
				score,
				chunks: [chunk],
			});
			continue;
		}
		existing.chunks.push(chunk);
		existing.score = Math.max(existing.score, score);
	}

	const results = [...byConcept.values()];
	for (const result of results) {
		result.chunks.sort(byScoreThen((chunk) => chunk.ordinal));
		result.chunks = result.chunks.slice(
			0,
			Math.max(1, options.chunksPerConcept),
		);
	}
	results.sort(byScoreThen((result) => result.path));

	return results.slice(0, Math.max(1, options.limit));
}

/**
 * Two candidate lists as one, without the same passage twice. The FTS row
 * wins a collision: it carries a real BM25 rank, where a title match has none.
 */
function mergeCandidates(
	matched: CandidateRow[],
	titled: CandidateRow[],
): CandidateRow[] {
	const seen = new Set(
		matched.map((row) => `${row.concept_id}:${row.ordinal}`),
	);
	const extra = titled.filter(
		(row) => !seen.has(`${row.concept_id}:${row.ordinal}`),
	);
	return [...matched, ...extra];
}

/** Score descending, with a stable tiebreak so equal scores do not shuffle. */
function byScoreThen<T extends { score: number }>(
	key: (item: T) => number | string,
): (a: T, b: T) => number {
	return (a, b) => {
		if (a.score !== b.score) {
			return b.score - a.score;
		}
		const left = key(a);
		const right = key(b);
		if (left === right) {
			return 0;
		}
		return left < right ? -1 : 1;
	};
}

/** The filters every candidate must satisfy, whichever query found it. */
function buildFilters(options: SearchOptions): {
	conditions: string[];
	parameters: Array<string | number>;
} {
	const conditions: string[] = [];
	const parameters: Array<string | number> = [];

	addSetFilter(conditions, parameters, "lower(c.type)", options.types);
	addSetFilter(conditions, parameters, "lower(c.status)", options.statuses);
	addSetFilter(conditions, parameters, "lower(c.trust)", options.trusts);

	if (options.tags !== undefined && options.tags.length > 0) {
		const placeholders = options.tags.map(() => "?").join(", ");
		conditions.push(
			`EXISTS (SELECT 1 FROM tags t WHERE t.concept_id = c.id AND lower(t.tag) IN (${placeholders}))`,
		);
		parameters.push(...options.tags.map(normalize));
	}

	// A directory filter includes what is nested beneath it: asking for
	// `concepts` is asking for the subtree, not for one flat level.
	if (options.dirs !== undefined && options.dirs.length > 0) {
		const clauses = options.dirs.map(() => "(c.dir = ? OR c.dir LIKE ?)");
		conditions.push(`(${clauses.join(" OR ")})`);
		for (const dir of options.dirs) {
			const trimmed = dir.replace(/^\.?\/+|\/+$/g, "");
			parameters.push(trimmed, `${trimmed}/%`);
		}
	}

	// A deprecated concept is not an answer unless it was asked for, either by
	// name through --status or wholesale through --include-deprecated.
	const askedForDeprecated =
		options.includeDeprecated === true ||
		(options.statuses ?? []).some(
			(status) => normalize(status) === "deprecated",
		);
	if (!askedForDeprecated) {
		conditions.push("(c.status IS NULL OR lower(c.status) <> 'deprecated')");
	}

	return { conditions, parameters };
}

/** The columns every candidate row is built from, FTS rank aside. */
const CANDIDATE_COLUMNS = `
	ch.concept_id, ch.ordinal, ch.heading, ch.heading_path,
	ch.start_line, ch.end_line, ch.start_char, ch.end_char, ch.content,
	c.path, c.identifier, c.title, c.type, c.status, c.trust, c.stale_after`;

function selectCandidates(
	db: Database,
	match: string,
	options: SearchOptions,
): CandidateRow[] {
	const { conditions, parameters } = buildFilters(options);
	const candidates = Math.max(
		MIN_CANDIDATES,
		options.limit * Math.max(1, options.chunksPerConcept) * CANDIDATE_MULTIPLE,
	);

	return db
		.query<CandidateRow, Array<string | number>>(
			`SELECT ${CANDIDATE_COLUMNS},
				bm25(chunks_fts, ${HEADING_WEIGHT}, ${CONTENT_WEIGHT}) AS rank
			FROM chunks_fts
			JOIN chunks ch ON ch.id = chunks_fts.rowid
			JOIN concepts c ON c.id = ch.concept_id
			WHERE ${["chunks_fts MATCH ?", ...conditions].join(" AND ")}
			ORDER BY rank
			LIMIT ?`,
		)
		.all(match, ...parameters, candidates);
}

/**
 * Concepts whose title names the query.
 *
 * The FTS index covers heading paths and body text, not frontmatter, so a
 * document titled "Widget internals" whose prose never says "widget" is
 * invisible to `selectCandidates` — and it is exactly the document someone
 * searching for "widget" wanted. Its opening passage stands in for it, at
 * title tier with no BM25 relevance of its own.
 */
function selectTitleMatches(
	db: Database,
	tokens: string[],
	options: SearchOptions,
): CandidateRow[] {
	if (tokens.length === 0) {
		return [];
	}

	const { conditions, parameters } = buildFilters(options);
	// Tokens are letters, digits and underscores only, so they carry no LIKE
	// wildcard; the loose match here is narrowed by `containsToken` below.
	const like = tokens.map(() => "lower(c.title) LIKE ?").join(" OR ");

	const rows = db
		.query<CandidateRow, Array<string | number>>(
			`SELECT ${CANDIDATE_COLUMNS}, 0 AS rank
			FROM concepts c
			JOIN chunks ch ON ch.concept_id = c.id
			WHERE ${[
				"c.title IS NOT NULL",
				`(${like})`,
				"ch.ordinal = (SELECT min(ordinal) FROM chunks WHERE concept_id = c.id)",
				...conditions,
			].join(" AND ")}
			LIMIT ?`,
		)
		.all(
			...tokens.map((token) => `%${token}%`),
			...parameters,
			Math.max(1, options.limit),
		);

	// LIKE matched anywhere inside a word; a title match means a whole word.
	return rows.filter(
		(row) => row.title !== null && containsToken(row.title, tokens),
	);
}

function addSetFilter(
	conditions: string[],
	parameters: Array<string | number>,
	column: string,
	values: string[] | undefined,
): void {
	if (values === undefined || values.length === 0) {
		return;
	}
	const placeholders = values.map(() => "?").join(", ");
	conditions.push(`${column} IN (${placeholders})`);
	parameters.push(...values.map(normalize));
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * The tier a row's match sits in. The title is checked first because a
 * document named after the query is the answer, whatever else matched.
 */
function tierOf(row: CandidateRow, tokens: string[]): number {
	if (row.title !== null && containsToken(row.title, tokens)) {
		return TIER_TITLE;
	}
	if (row.heading_path !== null && containsToken(row.heading_path, tokens)) {
		return TIER_HEADING;
	}
	return TIER_BODY;
}

/** Whether `text` uses any of the query's words. */
function containsToken(text: string, tokens: string[]): boolean {
	const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
	for (const token of tokens) {
		for (const word of words) {
			if (sameWord(word, token)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Two words the FTS index would likely have conflated. FTS5 stems with
 * Porter; re-implementing it here would be a second source of truth, so a
 * shared prefix long enough to be meaningful stands in for it — that is what
 * separates "chunk"/"chunking" from "cat"/"category".
 */
function sameWord(word: string, token: string): boolean {
	if (word === token) {
		return true;
	}
	const shorter = word.length < token.length ? word : token;
	const longer = word.length < token.length ? token : word;
	return shorter.length >= 4 && longer.startsWith(shorter);
}

/**
 * A passage's score.
 *
 * BM25 is a distance — more negative is better — so it is flipped and squashed
 * into [0, 1). That bound is what makes the tier and staleness offsets
 * decisive rather than merely influential.
 */
function scoreOf(tier: number, rank: number, stale: boolean): number {
	const relevance = Math.max(0, -rank);
	const normalized = relevance / (1 + relevance);
	return tier * TIER_WEIGHT + normalized - (stale ? STALE_PENALTY : 0);
}

/** Past its staleness date. An absent or unreadable date is not stale. */
function isStale(staleAfter: string | null, now: Date): boolean {
	if (staleAfter === null) {
		return false;
	}
	const at = Date.parse(staleAfter);
	return !Number.isNaN(at) && at < now.getTime();
}

/**
 * A window of the passage around its first matching word, so the snippet shows
 * why the passage was returned rather than just how it begins.
 */
function snippetOf(content: string, tokens: string[]): string {
	const text = content.trim();
	if (text.length <= SNIPPET_CHARS) {
		return text;
	}

	const found = firstMatch(text, tokens);
	if (found <= SNIPPET_CHARS / 2) {
		return `${text.slice(0, SNIPPET_CHARS).trimEnd()}…`;
	}

	const start = found - Math.floor(SNIPPET_CHARS / 2);
	const end = start + SNIPPET_CHARS;
	const head = text.slice(start, end).trimStart();
	return `…${head.trimEnd()}${end < text.length ? "…" : ""}`;
}

function firstMatch(text: string, tokens: string[]): number {
	const haystack = text.toLowerCase();
	let earliest = -1;
	for (const token of tokens) {
		const at = haystack.indexOf(token);
		if (at !== -1 && (earliest === -1 || at < earliest)) {
			earliest = at;
		}
	}
	return earliest === -1 ? 0 : earliest;
}
