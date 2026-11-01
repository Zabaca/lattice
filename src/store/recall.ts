/**
 * Asking the store what it knows.
 *
 * This is today's hybrid search, unchanged, with its answers described the
 * way an agent needs them: the note, the section a passage sits in, whether
 * it has been checked, whether it is old, and whether search ran fully.
 */

import type { Database } from "bun:sqlite";
import type { EmbeddingProvider } from "../embed/provider.js";
import { embeddedChunkCount, readActiveSpace } from "../embed/state.js";
import type { Reranker } from "../rerank/provider.js";
import { embedWith } from "../search/embed-query.js";
import {
	type SearchHit,
	type SearchResult,
	search,
	searchConcepts,
} from "../search/search.js";
import { checkedLabel, firstLine } from "./read.js";
import type { Trust } from "./store.js";

export interface RecallInput {
	question: string;
	type?: string;
	tag?: string;
	/** Look only within these notes. */
	notes?: string[];
	includeArchived?: boolean;
	/** What to return the best of: passages (the default) or whole notes. */
	best?: "passages" | "notes";
	limit?: number;
}

export interface RecallContext {
	db: Database;
	/** The provider the server holds, or why there is none. */
	provider: () => EmbeddingProvider | { unavailable: string };
	reranker?: Reranker;
	now?: number;
}

interface Flags {
	old?: true;
	full_text_lost?: true;
	stale?: true;
	/** Reached through a link from another answer, so a lead rather than an answer. */
	via?: string;
}

export interface Passage extends Flags {
	note: string;
	title: string | null;
	section: string | null;
	heading: string | null;
	text: string;
	checked: "unchecked" | "agent" | "james";
}

export interface NoteHit extends Flags {
	note: string;
	title: string | null;
	about: string;
	checked: string;
}

export interface Recalled {
	/** "full", or "keyword-only: why". */
	search: string;
	passages_without_vectors: number;
	reranked?: string;
	passages?: Passage[];
	notes?: NoteHit[];
}

const DEFAULT_PASSAGES = 5;
/** Neighbours reached by a link that may follow the passages. */
const NEIGHBOURS = 2;

export async function recall(
	context: RecallContext,
	input: RecallInput,
): Promise<Recalled> {
	const { db } = context;
	const provider = context.provider();
	const embedded =
		"unavailable" in provider
			? { reason: provider.unavailable }
			: await embedWith(provider, input.question);

	const mode = input.best ?? "passages";
	const limit = Math.min(Math.max(input.limit ?? DEFAULT_PASSAGES, 1), 25);
	const options = {
		query: input.question,
		limit,
		chunksPerConcept: 2,
		asOf: context.now ?? Date.now(),
		expand: NEIGHBOURS,
		reranker: context.reranker,
		candidates: Math.max(20, limit),
		semantic: embedded.semantic,
		semanticUnavailable: embedded.reason,
		type: input.type,
		tag: input.tag,
		notes: input.notes,
		excludeArchived: input.includeArchived !== true,
	};
	const result =
		mode === "notes"
			? await searchConcepts(db, options)
			: await search(db, options);

	const space = embedded.space ?? readActiveSpace(db);
	const passages =
		db.query<{ n: number }, []>("SELECT count(*) AS n FROM chunks").get()?.n ??
		0;
	const answer: Recalled = {
		search: result.degraded ? `keyword-only: ${result.degradedReason}` : "full",
		passages_without_vectors:
			passages - (space === undefined ? 0 : embeddedChunkCount(db, space)),
	};
	if (result.rerank !== null) {
		answer.reranked = result.rerank.provider;
	} else if (result.rerankReason !== undefined) {
		answer.reranked = `not reranked: ${result.rerankReason}`;
	}

	if (mode === "notes") {
		answer.notes = result.hits.map((hit) => noteHit(db, hit));
	} else {
		answer.passages = passagesOf(db, result, limit);
	}
	return answer;
}

/** The best `limit` passages of the direct answers, then the neighbours a link led to. */
function passagesOf(
	db: Database,
	result: SearchResult,
	limit: number,
): Passage[] {
	const direct = result.hits
		.filter((hit) => hit.expanded !== true)
		.flatMap((hit, rank) => hit.chunks.map((chunk) => ({ hit, chunk, rank })))
		.sort(
			(a, b) =>
				b.chunk.score - a.chunk.score ||
				a.rank - b.rank ||
				a.chunk.ordinal - b.chunk.ordinal,
		)
		.slice(0, limit);
	const neighbours = result.hits
		.filter((hit) => hit.expanded === true)
		.flatMap((hit) => hit.chunks.map((chunk) => ({ hit, chunk, rank: 0 })));

	return [...direct, ...neighbours].map(({ hit, chunk }) =>
		passage(db, hit, chunk.ordinal),
	);
}

function passage(db: Database, hit: SearchHit, ordinal: number): Passage {
	const row = db
		.query<
			{ content: string; section_id: string | null; concept_id: number },
			[string, number]
		>(
			`SELECT ch.content, ch.section_id, ch.concept_id FROM chunks ch
			JOIN concepts c ON c.id = ch.concept_id
			WHERE c.identifier = ? AND ch.ordinal = ?`,
		)
		.get(hit.identifier, ordinal);
	const section =
		row?.section_id == null
			? null
			: db
					.query<{ heading: string | null; trust: Trust }, [number, string]>(
						"SELECT heading, trust FROM sections WHERE concept_id = ? AND sid = ?",
					)
					.get(row.concept_id, row.section_id);

	return {
		note: hit.identifier,
		title: hit.title,
		section: row?.section_id ?? null,
		heading: section?.heading ?? null,
		text: row?.content ?? "",
		checked: checkedLabel(section?.trust ?? "unverified"),
		...flags(db, hit),
	};
}

function noteHit(db: Database, hit: SearchHit): NoteHit {
	const row = db
		.query<
			{
				id: number;
				description: string | null;
				sections: number;
				checked: number;
			},
			[string]
		>(
			`SELECT c.id, c.description,
				(SELECT count(*) FROM sections s WHERE s.concept_id = c.id) AS sections,
				(SELECT count(*) FROM sections s WHERE s.concept_id = c.id AND s.trust <> 'unverified') AS checked
			FROM concepts c WHERE c.identifier = ?`,
		)
		.get(hit.identifier);
	return {
		note: hit.identifier,
		title: hit.title,
		about: firstLine(row?.description ?? null),
		checked: `${row?.checked ?? 0} of ${row?.sections ?? 0} sections`,
		...flags(db, hit),
	};
}

/**
 * What a reader should weigh a result by. An old note is reported as old and
 * not as stale: it is stale by construction, which says nothing more.
 */
function flags(db: Database, hit: SearchHit): Flags {
	const tags = db
		.query<{ tag: string }, [string]>(
			`SELECT t.tag FROM tags t JOIN concepts c ON c.id = t.concept_id
			WHERE c.identifier = ? AND t.tag IN ('old', 'full-text-lost')`,
		)
		.all(hit.identifier)
		.map((row) => row.tag);

	const out: Flags = {};
	const old = tags.includes("old");
	if (old) {
		out.old = true;
	}
	if (tags.includes("full-text-lost")) {
		out.full_text_lost = true;
	}
	if (hit.stale && !old) {
		out.stale = true;
	}
	if (hit.via !== undefined) {
		out.via = `${hit.via.relation} of ${hit.via.from.replace(/\.md$/, "")}`;
	}
	return out;
}
