/**
 * Turning what is indexed into vectors.
 *
 * This is the second phase of a sync and the whole of `lattice embed`: one
 * code path, so there is one thing to reason about and one thing to test.
 *
 * A chunk with no vector is simply a row missing from `chunk_embeddings` for
 * the active space, so an interrupted run leaves a backlog rather than a
 * half-written document, and the next run picks it up. Each target is written
 * in its own transaction for the same reason.
 *
 * Everything here is scoped to a vector space — a (model, dim) pair. That is
 * what lets a re-embed fill a second space beside the one still answering
 * queries, and swap the two only once it is done.
 */

import type { Database } from "bun:sqlite";
import { EmbeddingError, type EmbeddingProvider, toBlob } from "./provider.js";
import {
	readActiveSpace,
	type VectorSpace,
	writeActiveSpace,
} from "./state.js";

export interface EmbedOptions {
	/** Also retry targets recorded as permanently failed. */
	retryFailed?: boolean;
	/**
	 * Rebuild the index in the provider's space, replacing whatever space it
	 * is in now. Without this, a mismatch is the caller's to refuse.
	 */
	reEmbed?: boolean;
}

export interface EmbedReport {
	model: string;
	dim: number;
	chunks: number;
	concepts: number;
	/** Targets that failed this run, however they were classified. */
	failed: number;
	/** Targets skipped because a permanent failure is already recorded. */
	skipped: number;
	/** Set by a re-embed: whether the new space took over from the old. */
	swapped?: boolean;
	/** The space left behind by a completed re-embed. */
	replaced?: VectorSpace;
}

interface Target {
	id: number;
	text: string;
}

/**
 * What each kind of target needs: where to read it, where its rows live, and
 * the SQL for the text it is embedded from.
 *
 * `text` is one expression used by every query here, so "what would be
 * embedded", "what is still missing" and "is the new space complete" are the
 * same question asked three ways rather than three definitions that can
 * drift apart.
 */
const CHUNKS = {
	table: "chunks",
	embeddings: "chunk_embeddings",
	failures: "chunk_embed_failures",
	key: "chunk_id",
	text: `CASE WHEN t.heading_path = '' OR t.heading_path IS NULL
		THEN t.content ELSE t.heading_path || char(10) || char(10) || t.content END`,
} as const;

const CONCEPTS = {
	table: "concepts",
	embeddings: "concept_embeddings",
	failures: "concept_embed_failures",
	key: "concept_id",
	/** What a concept calls itself and what it is about, rather than its body. */
	text: `coalesce(t.title, '') || char(10) || char(10) ||
		coalesce(t.description, '') || char(10) || char(10) ||
		coalesce((SELECT group_concat(tag, ', ' ORDER BY tag)
			FROM tags WHERE concept_id = t.id), '')`,
} as const;

type Kind = typeof CHUNKS | typeof CONCEPTS;

/**
 * SQLite's one-argument `trim` strips spaces and nothing else, so the
 * whitespace that actually matters here — the newlines joining a concept's
 * empty title, description and tags — has to be spelled out.
 */
const BLANK = "' ' || char(9) || char(10) || char(13)";

/** The target's text, with the joins around empty parts stripped off. */
function text(kind: Kind): string {
	return `trim(${kind.text}, ${BLANK})`;
}

/**
 * A target with nothing to embed — an untitled, undescribed, untagged concept
 * — is not a backlog item. Counting one as pending would mean a re-embed
 * could never report itself complete.
 */
function embeddable(kind: Kind): string {
	return `${text(kind)} <> ''`;
}

/** No vector in this space. Two bound parameters: model, dim. */
function notEmbedded(kind: Kind): string {
	return `t.id NOT IN (SELECT ${kind.key} FROM ${kind.embeddings}
		WHERE model = ? AND dim = ?)`;
}

/** Not written off in this space. Two bound parameters: model, dim. */
function notWrittenOff(kind: Kind): string {
	return `t.id NOT IN (SELECT ${kind.key} FROM ${kind.failures}
		WHERE retryable = 0 AND model = ? AND dim = ?)`;
}

/**
 * Embed everything that is missing a vector in the provider's space.
 *
 * Failures never stop the run: the target is recorded and the rest go on, so
 * one unembeddable passage cannot cost a whole bundle its index.
 */
export async function embedPending(
	db: Database,
	provider: EmbeddingProvider,
	options: EmbedOptions = {},
): Promise<EmbedReport> {
	const space: VectorSpace = { model: provider.model, dim: provider.dim };
	const report: EmbedReport = {
		model: space.model,
		dim: space.dim,
		chunks: 0,
		concepts: 0,
		failed: 0,
		skipped: 0,
	};

	const previous = readActiveSpace(db);

	if (options.retryFailed) {
		clearPermanentFailures(db, space);
	}

	if (previous === undefined) {
		// A first embed claims the space before writing a single vector, so an
		// interruption cannot leave vectors behind that no pointer accounts
		// for — and a later model change is still caught.
		writeActiveSpace(db, space);
	}

	report.chunks = await embedKind(db, provider, CHUNKS, space, report);
	report.concepts = await embedKind(db, provider, CONCEPTS, space, report);

	if (options.reEmbed && previous !== undefined) {
		report.swapped = finishReEmbed(db, space, previous);
		if (report.swapped) {
			report.replaced = previous;
		}
	}

	return report;
}

/**
 * Hand the index over to the new space — but only once every embeddable
 * target actually holds a vector in it.
 *
 * The gate is deliberately not "nothing is pending": a target written off as
 * permanently failed is not pending, and swapping on that basis would delete
 * an old vector the new space does not have and cannot produce. Completeness
 * is counted from the rows themselves.
 *
 * The pointer moves and the old vectors go in the same transaction, so the
 * index is never between spaces: until this commits, every query is still
 * answered by the old set, and an interrupted re-embed simply resumes.
 */
function finishReEmbed(
	db: Database,
	space: VectorSpace,
	previous: VectorSpace,
): boolean {
	if (
		unembeddedCount(db, CHUNKS, space) > 0 ||
		unembeddedCount(db, CONCEPTS, space) > 0
	) {
		return false;
	}

	db.transaction(() => {
		for (const kind of [CHUNKS, CONCEPTS]) {
			db.query(
				`DELETE FROM ${kind.embeddings} WHERE NOT (model = ? AND dim = ?)`,
			).run(space.model, space.dim);
			db.query(
				`DELETE FROM ${kind.failures} WHERE NOT (model = ? AND dim = ?)`,
			).run(space.model, space.dim);
		}
		writeActiveSpace(db, space);
	})();

	return true;
}

function clearPermanentFailures(db: Database, space: VectorSpace): void {
	for (const kind of [CHUNKS, CONCEPTS]) {
		db.query(
			`DELETE FROM ${kind.failures} WHERE retryable = 0 AND model = ? AND dim = ?`,
		).run(space.model, space.dim);
	}
}

/**
 * Embeddable targets with no vector in `space`, whatever is recorded about
 * why. This is what "is the new space complete?" means.
 */
function unembeddedCount(db: Database, kind: Kind, space: VectorSpace): number {
	return (
		db
			.query<{ n: number }, [string, number]>(
				`SELECT count(*) AS n FROM ${kind.table} t
				WHERE ${embeddable(kind)} AND ${notEmbedded(kind)}`,
			)
			.get(space.model, space.dim)?.n ?? 0
	);
}

/**
 * Chunks awaiting a vector in `space`, targets written off excluded — they
 * are not waiting for anything. Counted rather than selected: `status` wants
 * the number, not ten thousand passages of text.
 */
export function pendingChunkCount(db: Database, space: VectorSpace): number {
	return (
		db
			.query<{ n: number }, [string, number, string, number]>(
				`SELECT count(*) AS n FROM ${CHUNKS.table} t
				WHERE ${embeddable(CHUNKS)}
					AND ${notEmbedded(CHUNKS)}
					AND ${notWrittenOff(CHUNKS)}`,
			)
			.get(space.model, space.dim, space.model, space.dim)?.n ?? 0
	);
}

/** What this run has to embed: everything pending, with its text. */
function targets(db: Database, kind: Kind, space: VectorSpace): Target[] {
	return db
		.query<Target, [string, number, string, number]>(
			`SELECT t.id AS id, ${text(kind)} AS text
			FROM ${kind.table} t
			WHERE ${embeddable(kind)}
				AND ${notEmbedded(kind)}
				AND ${notWrittenOff(kind)}
			ORDER BY t.id`,
		)
		.all(space.model, space.dim, space.model, space.dim);
}

async function embedKind(
	db: Database,
	provider: EmbeddingProvider,
	kind: Kind,
	space: VectorSpace,
	report: EmbedReport,
): Promise<number> {
	let written = 0;

	for (const target of targets(db, kind, space)) {
		let vector: Float32Array;
		try {
			[vector] = await provider.embed([target.text]);
		} catch (error) {
			recordFailure(db, kind, target.id, space, error);
			report.failed++;
			continue;
		}

		db.transaction(() => {
			db.query(
				`INSERT INTO ${kind.embeddings} (${kind.key}, model, dim, vector)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(${kind.key}, model, dim) DO UPDATE SET
					vector = excluded.vector, created_at = datetime('now')`,
			).run(target.id, space.model, space.dim, toBlob(vector));
			db.query(
				`DELETE FROM ${kind.failures} WHERE ${kind.key} = ? AND model = ? AND dim = ?`,
			).run(target.id, space.model, space.dim);
		})();
		written++;
	}

	report.skipped += countPermanent(db, kind, space);
	return written;
}

/**
 * Record why a target has no vector, keeping a count of attempts so a
 * repeatedly retryable failure is still visible as one.
 */
function recordFailure(
	db: Database,
	kind: Kind,
	id: number,
	space: VectorSpace,
	error: unknown,
): void {
	const retryable = error instanceof EmbeddingError ? error.retryable : true;
	const message = error instanceof Error ? error.message : String(error);

	db.query(
		`INSERT INTO ${kind.failures} (${kind.key}, model, dim, retryable, attempts, message)
		VALUES (?, ?, ?, ?, 1, ?)
		ON CONFLICT(${kind.key}, model, dim) DO UPDATE SET
			retryable = excluded.retryable,
			attempts = ${kind.failures}.attempts + 1,
			message = excluded.message, failed_at = datetime('now')`,
	).run(id, space.model, space.dim, retryable ? 1 : 0, message);
}

function countPermanent(db: Database, kind: Kind, space: VectorSpace): number {
	return (
		db
			.query<{ n: number }, [string, number]>(
				`SELECT count(*) AS n FROM ${kind.failures}
				WHERE retryable = 0 AND model = ? AND dim = ?`,
			)
			.get(space.model, space.dim)?.n ?? 0
	);
}
