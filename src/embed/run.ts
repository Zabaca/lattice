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
 *
 * Every row is scoped to the model that produced it, and `meta.embedding_model`
 * says which model the index is currently FOR. Embedding under a different
 * model is refused rather than mixed in, because two models' vectors are not
 * comparable even when their dimensions agree. `reembed` is the one way
 * through: it fills in the new model beside the old and flips the pointer only
 * once the new set is complete.
 */

import type { Database } from "bun:sqlite";
import { EmbeddingError, type EmbeddingProvider, toBlob } from "./provider.js";

/** The `meta` key holding the model the index's vectors are read under. */
const ACTIVE_MODEL_KEY = "embedding_model";

export interface EmbedOptions {
	/** Also retry targets recorded as permanently failed. */
	retryFailed?: boolean;
	/** Re-embed under a changed model instead of refusing. */
	reembed?: boolean;
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
	/** The model being replaced, while a re-embed is in flight. */
	replacing?: string;
	/** True when this run completed a re-embed and moved the pointer. */
	flipped: boolean;
}

/**
 * The index holds vectors from a different model than the one now configured.
 *
 * Thrown rather than handled here: only the command knows how to phrase it,
 * and only the user can decide to re-embed.
 */
export class ModelChangeError extends Error {
	readonly indexModel: string;
	readonly configuredModel: string;
	readonly chunks: number;
	readonly source: string;

	constructor(
		indexModel: string,
		configuredModel: string,
		chunks: number,
		source: string,
	) {
		super(
			`The index was embedded with ${indexModel}, but ${configuredModel} is configured (from ${source}).\n` +
				`${chunks} chunk${chunks === 1 ? "" : "s"} would have to be re-embedded; vectors from two models cannot be compared.\n` +
				"Run `lattice embed --reembed` to rebuild them, or restore the previous model.",
		);
		this.name = "ModelChangeError";
		this.indexModel = indexModel;
		this.configuredModel = configuredModel;
		this.chunks = chunks;
		this.source = source;
	}
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

/** The model the index's vectors are read under, or undefined before the first run. */
export function activeModel(db: Database): string | undefined {
	return (
		db
			.query<{ value: string }, [string]>(
				"SELECT value FROM meta WHERE key = ?",
			)
			.get(ACTIVE_MODEL_KEY)?.value ?? undefined
	);
}

function setActiveModel(db: Database, model: string): void {
	db.query(
		"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(ACTIVE_MODEL_KEY, model);
}

/**
 * Refuse if the configured model is not the one the index was built with.
 *
 * Callers that only read vectors — search — use this on its own, so a mixed
 * index is never queried rather than being quietly searched half-blind.
 */
export function assertModelMatches(
	db: Database,
	provider: EmbeddingProvider,
): void {
	const active = activeModel(db);
	if (active === undefined || active === provider.model) {
		return;
	}
	throw new ModelChangeError(
		active,
		provider.model,
		countVectors(db, CHUNKS, active),
		provider.source,
	);
}

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
	const active = activeModel(db);
	const replacing =
		active !== undefined && active !== provider.model ? active : undefined;

	if (replacing !== undefined && options.reembed !== true) {
		throw new ModelChangeError(
			replacing,
			provider.model,
			countVectors(db, CHUNKS, replacing),
			provider.source,
		);
	}
	if (active === undefined) {
		setActiveModel(db, provider.model);
	}

	const report: EmbedReport = {
		model: provider.model,
		dim: provider.dim,
		chunks: 0,
		concepts: 0,
		failed: 0,
		skipped: 0,
		replacing,
		flipped: false,
	};

	if (options.retryFailed) {
		db.exec("DELETE FROM chunk_embed_failures WHERE retryable = 0");
		db.exec("DELETE FROM concept_embed_failures WHERE retryable = 0");
	} else if (replacing !== undefined) {
		// A failure is a judgement one model made about one passage, and the
		// new model has not made it. Carrying it over would leave the chunk
		// with no vector at all once the old set is deleted.
		db.query("DELETE FROM chunk_embed_failures WHERE model <> ?").run(
			provider.model,
		);
		db.query("DELETE FROM concept_embed_failures WHERE model <> ?").run(
			provider.model,
		);
	}

	report.chunks = await embedKind(
		db,
		provider,
		CHUNKS,
		targets(db, CHUNKS, provider.model),
		report,
	);
	report.concepts = await embedKind(
		db,
		provider,
		CONCEPTS,
		targets(db, CONCEPTS, provider.model),
		report,
	);

	if (replacing !== undefined && isComplete(db, provider.model)) {
		// The flip: the old vectors go and the pointer moves together, so no
		// reader ever sees an index with no model of its own. Until this
		// commits, `replacing` is still the active model and still complete.
		db.transaction(() => {
			db.query("DELETE FROM chunk_embeddings WHERE model = ?").run(replacing);
			db.query("DELETE FROM concept_embeddings WHERE model = ?").run(replacing);
			setActiveModel(db, provider.model);
		})();
		report.flipped = true;
	}

	return report;
}

/**
 * Chunks awaiting a vector under `model`, permanent failures excluded — they
 * are not waiting for anything. Counted rather than selected: `status` wants
 * the number, not ten thousand passages of text.
 */
export function pendingChunkCount(db: Database, model: string): number {
	return (
		db
			.query<{ n: number }, [string]>(
				`SELECT count(*) AS n FROM chunks
				WHERE id NOT IN (SELECT chunk_id FROM chunk_embeddings WHERE model = ?)
					AND id NOT IN (SELECT chunk_id FROM chunk_embed_failures WHERE retryable = 0)`,
			)
			.get(model)?.n ?? 0
	);
}

/** Vectors recorded under one model, which is what a model change costs. */
function countVectors(db: Database, kind: Kind, model: string): number {
	return (
		db
			.query<{ n: number }, [string]>(
				`SELECT count(*) AS n FROM ${kind.embeddings} WHERE model = ?`,
			)
			.get(model)?.n ?? 0
	);
}

/** Nothing left to embed under `model`, so its set can replace the old one. */
function isComplete(db: Database, model: string): boolean {
	return (
		targets(db, CHUNKS, model).length === 0 &&
		targets(db, CONCEPTS, model).length === 0
	);
}

function targets(db: Database, kind: Kind, model: string): Target[] {
	return kind === CHUNKS ? chunkTargets(db, model) : conceptTargets(db, model);
}

function chunkTargets(db: Database, model: string): Target[] {
	return db
		.query<Target, [string]>(
			`SELECT c.id AS id,
				CASE WHEN c.heading_path = '' OR c.heading_path IS NULL
					THEN c.content ELSE c.heading_path || '

' || c.content END AS text
			FROM chunks c
			WHERE c.id NOT IN (SELECT chunk_id FROM chunk_embeddings WHERE model = ?)
				AND c.id NOT IN (SELECT chunk_id FROM chunk_embed_failures WHERE retryable = 0)
			ORDER BY c.id`,
		)
		.all(model);
}

/**
 * A concept's own text: what it calls itself and what it is about. A concept
 * with none of the three has nothing to embed and is left out entirely.
 */
function conceptTargets(db: Database, model: string): Target[] {
	return db
		.query<Target, [string]>(
			`SELECT c.id AS id,
				coalesce(c.title, '') || '

' || coalesce(c.description, '') || '

' ||
				coalesce((SELECT group_concat(tag, ', ' ORDER BY tag)
					FROM tags WHERE concept_id = c.id), '') AS text
			FROM concepts c
			WHERE c.id NOT IN (SELECT concept_id FROM concept_embeddings WHERE model = ?)
				AND c.id NOT IN (SELECT concept_id FROM concept_embed_failures WHERE retryable = 0)
			ORDER BY c.id`,
		)
		.all(model)
		.map((target) => ({ ...target, text: target.text.trim() }))
		.filter((target) => target.text !== "");
}

async function embedKind(
	db: Database,
	provider: EmbeddingProvider,
	kind: Kind,
	batch: Target[],
	report: EmbedReport,
): Promise<number> {
	let written = 0;

	for (const target of batch) {
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
				ON CONFLICT(${kind.key}, model) DO UPDATE SET
					dim = excluded.dim,
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
