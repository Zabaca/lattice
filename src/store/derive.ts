/**
 * The search index of one note, derived from its sections.
 *
 * A write to a note changes the passages, the keyword index, the links and
 * the tags that come from it, and this rebuilds them in the caller's
 * transaction. The vectors are the expensive part, so a passage whose text did
 * not change keeps the vector it had: the caller hands in a `VectorCarry` of
 * vectors keyed by the text they were made from, and every new passage with
 * the same text takes its vector from there.
 *
 * It repeats the insert statements `sync/index.ts` uses for files. That module
 * goes at the cutover, and sharing the statements would mean teaching the
 * file index about a column it does not have.
 */

import type { Database } from "bun:sqlite";
import { chunkDocument } from "../sync/chunk.js";
import { extractBodyLinks, extractSourceLinks } from "../sync/links.js";

/** One vector as stored: the space it is in and its bytes. */
export interface StoredVector {
	model: string;
	dim: number;
	vector: Uint8Array;
}

/**
 * Vectors by the text they were made from (a passage's heading path and its
 * content), one entry per vector space. The same text always has the same
 * vector, so any number of passages with that text may take it.
 */
export type VectorCarry = Map<string, StoredVector[]>;

/** What a passage is embedded from, as the key of a carry. */
export function carryKey(headingPath: string, contentHash: string): string {
	return `${headingPath}\u0000${contentHash}`;
}

/** The vectors a note's passages hold now, so a rebuild can give them back. */
export function carryFrom(db: Database, conceptId: number): VectorCarry {
	const carry: VectorCarry = new Map();
	const chunks = db
		.query<
			{ id: number; heading_path: string | null; content_hash: string },
			[number]
		>(
			"SELECT id, heading_path, content_hash FROM chunks WHERE concept_id = ? ORDER BY ordinal",
		)
		.all(conceptId);
	const vectors = db
		.query<
			{ chunk_id: number; model: string; dim: number; vector: Uint8Array },
			[number]
		>(
			`SELECT e.chunk_id, e.model, e.dim, e.vector FROM chunk_embeddings e
			JOIN chunks ch ON ch.id = e.chunk_id WHERE ch.concept_id = ?`,
		)
		.all(conceptId);

	const byChunk = new Map<number, StoredVector[]>();
	for (const row of vectors) {
		const list = byChunk.get(row.chunk_id) ?? [];
		list.push({ model: row.model, dim: row.dim, vector: row.vector });
		byChunk.set(row.chunk_id, list);
	}
	for (const chunk of chunks) {
		const held = byChunk.get(chunk.id);
		if (held !== undefined) {
			carry.set(carryKey(chunk.heading_path ?? "", chunk.content_hash), held);
		}
	}
	return carry;
}

export interface DerivedInput {
	conceptId: number;
	/** The note's directory in the virtual path, which relative links resolve against. */
	dir: string;
	/** The note's sections in order. */
	sections: Array<{ sid: string; text: string }>;
	tags: string[];
	sources: ReadonlyArray<string | Record<string, unknown>>;
}

export interface DerivedResult {
	chunks: number;
	/** Passages that kept a vector. */
	carried: number;
}

/**
 * Rebuild one note's passages, tags and links from its sections.
 *
 * Run it inside the transaction that wrote the sections. Links INTO the note
 * belong to other notes and survive; `resolveLinks` re-points them afterwards.
 */
export function refreshDerived(
	db: Database,
	input: DerivedInput,
	carry: VectorCarry,
): DerivedResult {
	const body = input.sections.map((section) => section.text).join("");
	const pieces = chunkDocument(body, 0, 0);

	// Where each section starts, so a passage can say which one it begins in.
	const starts: Array<{ sid: string; at: number }> = [];
	let offset = 0;
	for (const section of input.sections) {
		starts.push({ sid: section.sid, at: offset });
		offset += section.text.length;
	}
	const sectionAt = (at: number): string | null => {
		let found: string | null = null;
		for (const start of starts) {
			if (start.at > at) {
				break;
			}
			found = start.sid;
		}
		return found;
	};

	db.query("DELETE FROM chunks WHERE concept_id = ?").run(input.conceptId);
	db.query("DELETE FROM tags WHERE concept_id = ?").run(input.conceptId);
	db.query("DELETE FROM links WHERE source_concept_id = ?").run(
		input.conceptId,
	);

	const tag = db.query("INSERT INTO tags (concept_id, tag) VALUES (?, ?)");
	for (const value of input.tags) {
		tag.run(input.conceptId, value);
	}

	const insertChunk = db.query<
		{ id: number },
		[
			number,
			number,
			string | null,
			string,
			number,
			number,
			number,
			number,
			number,
			string,
			string,
			number,
			string | null,
		]
	>(
		`INSERT INTO chunks (
			concept_id, ordinal, heading, heading_path, depth,
			start_line, end_line, start_char, end_char,
			content, content_hash, token_estimate, section_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id`,
	);
	const insertVector = db.query(
		"INSERT INTO chunk_embeddings (chunk_id, model, dim, vector) VALUES (?, ?, ?, ?)",
	);

	const chunkIds: Array<number | null> = [];
	let carried = 0;
	for (const piece of pieces) {
		const inserted = insertChunk.get(
			input.conceptId,
			piece.ordinal,
			piece.heading ?? null,
			piece.headingPath,
			piece.depth,
			piece.startLine,
			piece.endLine,
			piece.startChar,
			piece.endChar,
			piece.content,
			piece.contentHash,
			piece.tokenEstimate,
			sectionAt(piece.startChar),
		);
		const id = inserted?.id ?? null;
		chunkIds.push(id);

		const held = carry.get(carryKey(piece.headingPath, piece.contentHash));
		if (id !== null && held !== undefined) {
			for (const vector of held) {
				insertVector.run(id, vector.model, vector.dim, vector.vector);
			}
			carried++;
		}
	}

	const insertLink = db.query(
		`INSERT INTO links (
			source_concept_id, source_chunk_id, target_path, raw_target,
			link_text, anchor, context, kind
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	// Citations first: a note's provenance precedes what it mentions.
	for (const authored of [
		...extractSourceLinks(input.sources, input.dir),
		...extractBodyLinks(body, input.dir),
	]) {
		insertLink.run(
			input.conceptId,
			chunkContaining(pieces, chunkIds, authored.charOffset),
			authored.targetPath,
			authored.rawTarget,
			authored.text ?? null,
			authored.anchor ?? null,
			authored.context ?? null,
			authored.kind,
		);
	}

	return { chunks: pieces.length, carried };
}

/**
 * The passage a link was written in. Passages overlap at a split seam, and the
 * first one containing the link is where the author wrote it.
 */
function chunkContaining(
	pieces: Array<{ startChar: number; endChar: number }>,
	chunkIds: Array<number | null>,
	offset: number | undefined,
): number | null {
	if (offset === undefined) {
		return null;
	}
	for (let i = 0; i < pieces.length; i++) {
		if (offset >= pieces[i].startChar && offset < pieces[i].endChar) {
			return chunkIds[i];
		}
	}
	return null;
}

/**
 * The note a link's `target_path` names: one that has that path now, or else
 * one that answered to that name before it was renamed, so a rename keeps
 * every link that pointed at the old name.
 */
const TARGET_OF = `COALESCE(
	(SELECT c.id FROM concepts c WHERE c.path = links.target_path),
	(SELECT n.concept_id FROM note_names n
		WHERE n.name = substr(links.target_path, 1, length(links.target_path) - 3)
			AND links.target_path LIKE '%.md')
)`;

/**
 * Point every link at the note its `target_path` names, and at nothing when
 * no such note exists. A link written before its target was is repaired by
 * running this once the target is there.
 */
export function resolveLinks(db: Database): void {
	db.query(`UPDATE links SET target_concept_id = ${TARGET_OF}`).run();
}

/**
 * The same, for one note's surroundings only, which is all a single write can
 * change: the links it wrote, and links elsewhere that were waiting for a note
 * of its name (or one of its old names) to exist.
 */
export function resolveLinksAround(db: Database, conceptId: number): void {
	db.query(
		`UPDATE links SET target_concept_id = ${TARGET_OF} WHERE source_concept_id = ?`,
	).run(conceptId);

	const names = [
		...db
			.query<{ path: string }, [number]>(
				"SELECT path FROM concepts WHERE id = ?",
			)
			.all(conceptId)
			.map((row) => row.path),
		...db
			.query<{ name: string }, [number]>(
				"SELECT name FROM note_names WHERE concept_id = ?",
			)
			.all(conceptId)
			.map((row) => `${row.name}.md`),
	];
	const waiting = db.query(
		"UPDATE links SET target_concept_id = ? WHERE target_concept_id IS NULL AND target_path = ?",
	);
	for (const name of names) {
		waiting.run(conceptId, name);
	}
}
