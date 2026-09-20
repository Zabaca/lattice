/**
 * Which vector space this index is in.
 *
 * Two models put "the same" text in two different places, and they do it
 * even when their vectors are the same width, so a mixed index does not look
 * broken — it just quietly returns the wrong passages. The defence is that
 * the active space is written down (`meta.embedding_model` / `meta.embedding_dim`)
 * and every command that reads or writes vectors compares it to the model it
 * was configured with.
 */

import type { Database } from "bun:sqlite";

/** A (model, dim) pair: one place vectors can live. */
export interface VectorSpace {
	model: string;
	dim: number;
}

export function sameSpace(a: VectorSpace, b: VectorSpace): boolean {
	return a.model === b.model && a.dim === b.dim;
}

export function describeSpace(space: VectorSpace): string {
	return `${space.model} (${space.dim} dimensions)`;
}

/**
 * The space the index is in, or undefined for an index that has never been
 * embedded — which is not a mismatch, it is a blank slate.
 */
export function readActiveSpace(db: Database): VectorSpace | undefined {
	const model = readMeta(db, "embedding_model");
	const dim = readMeta(db, "embedding_dim");
	if (model === undefined || dim === undefined) {
		return undefined;
	}

	const parsed = Number.parseInt(dim, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		// Reading this as "never embedded" would wave every guard through and
		// let a second model write into an index that already holds vectors.
		throw new Error(
			`The index records an unreadable embedding dimension (${dim}). ` +
				"Run `lattice embed --reembed` to rebuild it, or remove the database and run `lattice init`.",
		);
	}
	return { model, dim: parsed };
}

/** Point the index at `space`. Call inside the transaction that earns it. */
export function writeActiveSpace(db: Database, space: VectorSpace): void {
	writeMeta(db, "embedding_model", space.model);
	writeMeta(db, "embedding_dim", String(space.dim));
}

function readMeta(db: Database, key: string): string | undefined {
	const row = db
		.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
		.get(key);
	return row?.value;
}

function writeMeta(db: Database, key: string, value: string): void {
	db.query(
		`INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(key, value);
}

/**
 * How many chunks already hold a vector in `space` — the number a user needs
 * to judge how expensive a model change is going to be.
 */
export function embeddedChunkCount(db: Database, space: VectorSpace): number {
	return (
		db
			.query<{ n: number }, [string, number]>(
				"SELECT count(*) AS n FROM chunk_embeddings WHERE model = ? AND dim = ?",
			)
			.get(space.model, space.dim)?.n ?? 0
	);
}

/**
 * The gate every command that touches vectors passes through: the refusal
 * message when the index and the configuration name different spaces, and
 * undefined when they agree — or when the index has no vectors yet and any
 * space is still available to it.
 */
export function checkActiveSpace(
	db: Database,
	configured: VectorSpace,
	source: string,
): string | undefined {
	const active = readActiveSpace(db);
	if (active === undefined || sameSpace(active, configured)) {
		return undefined;
	}

	return modelChangeMessage(
		active,
		configured,
		embeddedChunkCount(db, active),
		source,
	);
}

/**
 * The one message a model change produces.
 *
 * It has to answer every question the user is about to ask — what changed,
 * how much is affected, which of the two sides they altered, and what single
 * command gets them out — because the alternative is a user who deletes the
 * database.
 */
export function modelChangeMessage(
	active: VectorSpace,
	configured: VectorSpace,
	affectedChunks: number,
	source: string,
): string {
	return [
		`This index was embedded with ${describeSpace(active)}, but the configured model is ` +
			`${describeSpace(configured)} (from ${source}).`,
		`Vectors from two models are not comparable, so ${affectedChunks} embedded ` +
			`chunk${affectedChunks === 1 ? "" : "s"} would be mixed with the new ones.`,
		"",
		`Run \`lattice embed --reembed\` to rebuild the index with ${describeSpace(configured)}, ` +
			`or restore the previous setting to keep using ${describeSpace(active)}.`,
	].join("\n");
}
