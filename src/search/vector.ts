/**
 * The semantic leg: finding passages by meaning rather than by word.
 *
 * Vectors are stored as float32 BLOBs beside their chunk, so this is a scan:
 * every candidate vector is read and compared against the query's. That is
 * deliberate at the scale Lattice indexes — a personal bundle is tens of
 * thousands of passages, and a scan of that costs less than the machinery an
 * approximate index would need. The scan reads only the vectors, never the
 * text; the text of the few passages that survive is fetched afterwards.
 *
 * Two rules keep this honest. A vector of a different dimension is skipped
 * rather than compared, and a similarity below `SIMILARITY_FLOOR` is treated
 * as no match at all — with an embedding that carries no meaning, every
 * similarity is noise around zero, and noise must not enter a ranking.
 */

import type { Database } from "bun:sqlite";
import { conceptFilters, type SearchFilters } from "./filters.js";

/** The query, embedded, and the model that embedded it. */
export interface SemanticInput {
	vector: Float32Array;
	model: string;
}

export interface VectorCandidate {
	chunkId: number;
	conceptId: number;
	/** Cosine similarity with the query, in [-1, 1]. */
	similarity: number;
}

/**
 * Below this, a match is indistinguishable from the similarity two unrelated
 * random unit vectors happen to have, and is not a match.
 */
export const SIMILARITY_FLOOR = 0.25;

interface VectorRow {
	chunk_id: number;
	concept_id: number;
	dim: number;
	vector: Uint8Array;
}

/**
 * The passages nearest the query, best first.
 *
 * `limit` caps how many survive the scan; everything below the floor is
 * dropped whether or not the limit was reached.
 */
export function vectorCandidates(
	db: Database,
	semantic: SemanticInput,
	filters: SearchFilters,
	limit: number,
): VectorCandidate[] {
	const bounds = conceptFilters(filters);

	const rows = db
		.query<VectorRow, [string, ...string[]]>(
			`SELECT e.chunk_id, ch.concept_id, e.dim, e.vector
			FROM chunk_embeddings e
			JOIN chunks ch ON ch.id = e.chunk_id
			JOIN concepts c ON c.id = ch.concept_id
			WHERE e.model = ?${bounds.sql}`,
		)
		.all(semantic.model, ...bounds.values);

	const scored: VectorCandidate[] = [];
	for (const row of rows) {
		const similarity = similarityTo(semantic.vector, row);
		if (similarity === undefined || similarity < SIMILARITY_FLOOR) {
			continue;
		}
		scored.push({
			chunkId: row.chunk_id,
			conceptId: row.concept_id,
			similarity,
		});
	}

	scored.sort((a, b) => b.similarity - a.similarity || a.chunkId - b.chunkId);
	return scored.slice(0, limit);
}

/**
 * How near the query each concept's own vector is.
 *
 * This is the document-level signal: what a concept calls itself and says it
 * is about, rather than any one of its passages. It is returned as a lookup
 * rather than as a ranking, because in passage search it is only ever allowed
 * to break a tie.
 */
export function conceptSimilarities(
	db: Database,
	semantic: SemanticInput,
	filters: SearchFilters,
): Map<number, number> {
	const bounds = conceptFilters(filters);

	const rows = db
		.query<
			{ concept_id: number; dim: number; vector: Uint8Array },
			[string, ...string[]]
		>(
			`SELECT e.concept_id, e.dim, e.vector
			FROM concept_embeddings e
			JOIN concepts c ON c.id = e.concept_id
			WHERE e.model = ?${bounds.sql}`,
		)
		.all(semantic.model, ...bounds.values);

	const similarities = new Map<number, number>();
	for (const row of rows) {
		const similarity = similarityTo(semantic.vector, row);
		if (similarity !== undefined && similarity >= SIMILARITY_FLOOR) {
			similarities.set(row.concept_id, similarity);
		}
	}
	return similarities;
}

/** Whether anything was ever embedded with this model. */
export function hasEmbeddings(db: Database, model: string): boolean {
	const row = db
		.query<{ n: number }, [string]>(
			"SELECT count(*) AS n FROM (SELECT 1 FROM chunk_embeddings WHERE model = ? LIMIT 1)",
		)
		.get(model);
	return (row?.n ?? 0) > 0;
}

function similarityTo(
	query: Float32Array,
	row: { dim: number; vector: Uint8Array },
): number | undefined {
	// A vector of another width was written by another model's run. Comparing
	// the overlapping prefix would invent a number; skipping says nothing.
	if (row.dim !== query.length) {
		return undefined;
	}
	return cosine(query, fromBlob(row.vector, row.dim));
}

/** A stored little-endian float32 BLOB, back as a vector. */
export function fromBlob(blob: Uint8Array, dim: number): Float32Array {
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const vector = new Float32Array(dim);
	for (let i = 0; i < dim; i++) {
		vector[i] = view.getFloat32(i * 4, true);
	}
	return vector;
}

/**
 * Cosine similarity. Stored vectors are written normalized, but a zero vector
 * is legal — a text a provider had nothing to say about — and is near nothing.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let magnitudeA = 0;
	let magnitudeB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		magnitudeA += a[i] * a[i];
		magnitudeB += b[i] * b[i];
	}
	if (magnitudeA === 0 || magnitudeB === 0) {
		return 0;
	}
	return dot / Math.sqrt(magnitudeA * magnitudeB);
}
