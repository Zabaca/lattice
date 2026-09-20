/**
 * Turning what is indexed into vectors.
 *
 * This is the second phase of a sync and the whole of `lattice embed`: one
 * code path, so there is one thing to reason about and one thing to test.
 *
 * A chunk with no vector is simply a row missing from `chunk_embeddings`, so
 * an interrupted run leaves a backlog rather than a half-written document, and
 * the next run picks it up. Each target is written in its own transaction for
 * the same reason.
 */

import type { Database } from "bun:sqlite";
import { EmbeddingError, type EmbeddingProvider, toBlob } from "./provider.js";

export interface EmbedOptions {
	/** Also retry targets recorded as permanently failed. */
	retryFailed?: boolean;
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
}

interface Target {
	id: number;
	text: string;
}

/** What each kind of target needs: where to read it, and where its rows live. */
const CHUNKS = {
	embeddings: "chunk_embeddings",
	failures: "chunk_embed_failures",
	key: "chunk_id",
} as const;

const CONCEPTS = {
	embeddings: "concept_embeddings",
	failures: "concept_embed_failures",
	key: "concept_id",
} as const;

type Kind = typeof CHUNKS | typeof CONCEPTS;

/**
 * Embed everything that is missing a vector.
 *
 * Failures never stop the run: the target is recorded and the rest go on, so
 * one unembeddable passage cannot cost a whole bundle its index.
 */
export async function embedPending(
	db: Database,
	provider: EmbeddingProvider,
	options: EmbedOptions = {},
): Promise<EmbedReport> {
	const report: EmbedReport = {
		model: provider.model,
		dim: provider.dim,
		chunks: 0,
		concepts: 0,
		failed: 0,
		skipped: 0,
	};

	if (options.retryFailed) {
		db.exec("DELETE FROM chunk_embed_failures WHERE retryable = 0");
		db.exec("DELETE FROM concept_embed_failures WHERE retryable = 0");
	}

	report.chunks = await embedKind(
		db,
		provider,
		CHUNKS,
		chunkTargets(db),
		report,
	);
	report.concepts = await embedKind(
		db,
		provider,
		CONCEPTS,
		conceptTargets(db),
		report,
	);

	return report;
}

/**
 * Chunks awaiting a vector, permanent failures excluded — they are not
 * waiting for anything. Counted rather than selected: `status` wants the
 * number, not ten thousand passages of text.
 */
export function pendingChunkCount(db: Database): number {
	return (
		db
			.query<{ n: number }, []>(
				`SELECT count(*) AS n FROM chunks
				WHERE id NOT IN (SELECT chunk_id FROM chunk_embeddings)
					AND id NOT IN (SELECT chunk_id FROM chunk_embed_failures WHERE retryable = 0)`,
			)
			.get()?.n ?? 0
	);
}

function chunkTargets(db: Database): Target[] {
	return db
		.query<Target, []>(
			`SELECT c.id AS id,
				CASE WHEN c.heading_path = '' OR c.heading_path IS NULL
					THEN c.content ELSE c.heading_path || '

' || c.content END AS text
			FROM chunks c
			WHERE c.id NOT IN (SELECT chunk_id FROM chunk_embeddings)
				AND c.id NOT IN (SELECT chunk_id FROM chunk_embed_failures WHERE retryable = 0)
			ORDER BY c.id`,
		)
		.all();
}

/**
 * A concept's own text: what it calls itself and what it is about. A concept
 * with none of the three has nothing to embed and is left out entirely.
 */
function conceptTargets(db: Database): Target[] {
	return db
		.query<Target, []>(
			`SELECT c.id AS id,
				coalesce(c.title, '') || '

' || coalesce(c.description, '') || '

' ||
				coalesce((SELECT group_concat(tag, ', ' ORDER BY tag)
					FROM tags WHERE concept_id = c.id), '') AS text
			FROM concepts c
			WHERE c.id NOT IN (SELECT concept_id FROM concept_embeddings)
				AND c.id NOT IN (SELECT concept_id FROM concept_embed_failures WHERE retryable = 0)
			ORDER BY c.id`,
		)
		.all()
		.map((target) => ({ ...target, text: target.text.trim() }))
		.filter((target) => target.text !== "");
}

async function embedKind(
	db: Database,
	provider: EmbeddingProvider,
	kind: Kind,
	targets: Target[],
	report: EmbedReport,
): Promise<number> {
	let written = 0;

	for (const target of targets) {
		let vector: Float32Array;
		try {
			[vector] = await provider.embed([target.text]);
		} catch (error) {
			recordFailure(db, kind, target.id, provider.model, error);
			report.failed++;
			continue;
		}

		db.transaction(() => {
			db.query(
				`INSERT INTO ${kind.embeddings} (${kind.key}, model, dim, vector)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(${kind.key}) DO UPDATE SET
					model = excluded.model, dim = excluded.dim,
					vector = excluded.vector, created_at = datetime('now')`,
			).run(target.id, provider.model, provider.dim, toBlob(vector));
			db.query(`DELETE FROM ${kind.failures} WHERE ${kind.key} = ?`).run(
				target.id,
			);
		})();
		written++;
	}

	report.skipped += countPermanent(db, kind);
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
	model: string,
	error: unknown,
): void {
	const retryable = error instanceof EmbeddingError ? error.retryable : true;
	const message = error instanceof Error ? error.message : String(error);

	db.query(
		`INSERT INTO ${kind.failures} (${kind.key}, model, retryable, attempts, message)
		VALUES (?, ?, ?, 1, ?)
		ON CONFLICT(${kind.key}) DO UPDATE SET
			model = excluded.model, retryable = excluded.retryable,
			attempts = ${kind.failures}.attempts + 1,
			message = excluded.message, failed_at = datetime('now')`,
	).run(id, model, retryable ? 1 : 0, message);
}

function countPermanent(db: Database, kind: Kind): number {
	return (
		db
			.query<{ n: number }, []>(
				`SELECT count(*) AS n FROM ${kind.failures} WHERE retryable = 0`,
			)
			.get()?.n ?? 0
	);
}
