/**
 * Indexing an OKF bundle into the Lattice index.
 *
 * Every file is hashed on every run and compared with what the index already
 * holds, so a repeat sync does no work; the content hash is also what lets a
 * renamed file keep its identity and its inbound links.
 *
 * Each document is committed in its own transaction: an interrupted sync
 * leaves whole documents behind rather than a half-written one, and the next
 * run simply picks up the rest.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { type Chunk, chunkDocument } from "./chunk.js";
import { extractBodyLinks, extractSourceLinks } from "./links.js";
import { parseConcept } from "./okf.js";
import { type BundleFile, scanBundle } from "./scan.js";

interface IndexedConcept {
	id: number;
	path: string;
	content_hash: string;
}

export interface FrontmatterProblem {
	path: string;
	problem: string;
}

export interface SyncPlan {
	added: BundleFile[];
	changed: BundleFile[];
	/** Files whose content moved to a new path; nothing derived is rebuilt. */
	renamed: Array<{ from: string; to: BundleFile }>;
	/** Bundle-relative paths that are indexed but no longer on disk. */
	deleted: string[];
	unchanged: number;
}

/** The 12 bound parameters of the chunk insert, in order. */
type ChunkParams = [
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
];

export interface SyncReport extends SyncPlan {
	chunks: number;
	problems: FrontmatterProblem[];
}

/**
 * Work out what a sync would do, without doing any of it. `lattice status`
 * reports this, and `lattice sync` executes it.
 */
export function planSync(db: Database, docsDir: string): SyncPlan {
	const onDisk = scanBundle(docsDir);
	const indexed = db
		.query<IndexedConcept, []>("SELECT id, path, content_hash FROM concepts")
		.all();

	const indexedByPath = new Map(indexed.map((row) => [row.path, row]));
	const added: BundleFile[] = [];
	const changed: BundleFile[] = [];

	for (const file of onDisk) {
		const existing = indexedByPath.get(file.path);
		if (existing === undefined) {
			added.push(file);
		} else if (existing.content_hash !== file.contentHash) {
			changed.push(file);
		}
	}

	const onDiskPaths = new Set(onDisk.map((file) => file.path));
	const missing = indexed.filter((row) => !onDiskPaths.has(row.path));

	// A file that vanished and one that appeared with the same content are the
	// same document under a new name. Pair them off, longest-standing first, so
	// the result does not depend on directory order.
	const renamed: SyncPlan["renamed"] = [];
	const availableByHash = new Map<string, IndexedConcept[]>();
	for (const row of missing) {
		const bucket = availableByHash.get(row.content_hash);
		if (bucket) {
			bucket.push(row);
		} else {
			availableByHash.set(row.content_hash, [row]);
		}
	}
	for (const bucket of availableByHash.values()) {
		bucket.sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	const stillAdded: BundleFile[] = [];
	for (const file of added) {
		const source = availableByHash.get(file.contentHash)?.shift();
		if (source === undefined) {
			stillAdded.push(file);
			continue;
		}
		renamed.push({ from: source.path, to: file });
	}

	const renamedFrom = new Set(renamed.map((entry) => entry.from));
	const deleted = missing
		.map((row) => row.path)
		.filter((path) => !renamedFrom.has(path))
		.sort();

	return {
		added: stillAdded,
		changed,
		renamed,
		deleted,
		unchanged:
			onDisk.length - stillAdded.length - changed.length - renamed.length,
	};
}

/**
 * Apply a plan. Returns what was done, plus every file whose frontmatter could
 * not be read as OKF — those are indexed anyway, with no type.
 */
export function applySync(db: Database, plan: SyncPlan): SyncReport {
	let chunks = 0;
	const problems: FrontmatterProblem[] = [];

	for (const path of plan.deleted) {
		db.transaction(() => {
			db.query("DELETE FROM concepts WHERE path = ?").run(path);
		})();
	}

	for (const { from, to } of plan.renamed) {
		db.transaction(() => {
			db.query(
				"UPDATE concepts SET path = ?, identifier = ?, dir = ? WHERE path = ?",
			).run(to.path, identifierOf(to.path), directoryOf(to.path), from);
		})();

		// A relative link is relative to the document that wrote it, so a move to
		// another directory changes what this document's own links point at, even
		// though not one character of it changed. Chunks and tags still hold.
		if (directoryOf(from) !== directoryOf(to.path)) {
			chunks += indexFile(db, to).chunks;
		}
	}

	for (const file of [...plan.added, ...plan.changed]) {
		const result = indexFile(db, file);
		chunks += result.chunks;
		if (result.problem) {
			problems.push({ path: file.path, problem: result.problem });
		}
	}

	// Problems belong to the whole bundle, not just to what this run touched.
	for (const row of db
		.query<{ path: string; frontmatter_error: string }, []>(
			"SELECT path, frontmatter_error FROM concepts WHERE frontmatter_error IS NOT NULL ORDER BY path",
		)
		.all()) {
		if (!problems.some((problem) => problem.path === row.path)) {
			problems.push({ path: row.path, problem: row.frontmatter_error });
		}
	}
	problems.sort((a, b) => (a.path < b.path ? -1 : 1));

	resolveLinks(db);

	return { ...plan, chunks, problems };
}

/** Index one file, replacing whatever was previously derived from it. */
function indexFile(
	db: Database,
	file: BundleFile,
): { chunks: number; problem?: string } {
	const raw = readFileSync(file.absolutePath, "utf8");
	const concept = parseConcept(raw);
	const pieces = chunkDocument(
		concept.body,
		concept.bodyOffset,
		concept.bodyLineOffset,
	);
	const dir = directoryOf(file.path);

	db.transaction(() => {
		// The row is updated rather than replaced, so a concept keeps its id
		// when its text changes and anything pointing at it survives the edit.
		const fields = [
			identifierOf(file.path),
			dir,
			concept.title ?? null,
			concept.type ?? null,
			concept.description ?? null,
			concept.status ?? null,
			concept.staleAfter ?? null,
			concept.trust,
			JSON.stringify(concept.rest),
			concept.problem ?? null,
			file.contentHash,
			file.byteSize,
			file.mtimeMs,
		] as const;

		const updated = db
			.query<{ id: number }, [...typeof fields, string]>(
				`UPDATE concepts SET
					identifier = ?, dir = ?, title = ?, type = ?, description = ?,
					status = ?, stale_after = ?, trust = ?, frontmatter = ?,
					frontmatter_error = ?, content_hash = ?, byte_size = ?, mtime_ms = ?,
					indexed_at = datetime('now')
				WHERE path = ?
				RETURNING id`,
			)
			.get(...fields, file.path);

		const row =
			updated ??
			db
				.query<{ id: number }, [string, ...typeof fields]>(
					`INSERT INTO concepts (
						path, identifier, dir, title, type, description, status, stale_after,
						trust, frontmatter, frontmatter_error, content_hash, byte_size, mtime_ms
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					RETURNING id`,
				)
				.get(file.path, ...fields);

		if (row === null) {
			throw new Error(`Failed to index ${file.path}`);
		}

		// Everything derived from the old text goes; the new text replaces it.
		db.query("DELETE FROM chunks WHERE concept_id = ?").run(row.id);
		db.query("DELETE FROM tags WHERE concept_id = ?").run(row.id);
		// Only this document's own edges. Links that point AT it belong to their
		// own authors and must survive an edit here.
		db.query("DELETE FROM links WHERE source_concept_id = ?").run(row.id);

		const tag = db.query("INSERT INTO tags (concept_id, tag) VALUES (?, ?)");
		for (const value of concept.tags) {
			tag.run(row.id, value);
		}

		const chunk = db.query<{ id: number }, ChunkParams>(
			`INSERT INTO chunks (
				concept_id, ordinal, heading, heading_path, depth,
				start_line, end_line, start_char, end_char,
				content, content_hash, token_estimate
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				RETURNING id`,
		);
		const chunkIds: Array<number | null> = [];
		for (const piece of pieces) {
			const inserted = chunk.get(
				row.id,
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
			);
			chunkIds.push(inserted?.id ?? null);
		}

		const link = db.query(
			`INSERT INTO links (
				source_concept_id, source_chunk_id, target_path, raw_target,
				link_text, anchor, context, kind
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		// Citations first: a document's provenance precedes what it mentions.
		for (const authored of [
			...extractSourceLinks(concept.sources, dir),
			...extractBodyLinks(concept.body, dir),
		]) {
			// Link offsets address the body; chunk offsets address the whole file.
			const fileOffset =
				authored.charOffset === undefined
					? undefined
					: authored.charOffset + concept.bodyOffset;
			link.run(
				row.id,
				chunkAt(pieces, chunkIds, fileOffset),
				authored.targetPath,
				authored.rawTarget,
				authored.text ?? null,
				authored.anchor ?? null,
				authored.context ?? null,
				authored.kind,
			);
		}
	})();

	return { chunks: pieces.length, problem: concept.problem };
}

/**
 * The id of the chunk a link was written in.
 *
 * Chunks overlap at a split seam, so the first containing chunk wins: that is
 * the passage the author wrote the link in, and the later one only repeats it.
 */
function chunkAt(
	pieces: Chunk[],
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
 * Point every link at the concept its `target_path` names, and at nothing when
 * no such document is indexed.
 *
 * This runs once over the whole bundle after the documents are written, which
 * is what makes an unresolved link self-healing: whichever order the files were
 * indexed in, a link written before its target existed resolves as soon as the
 * target does, without the author touching the link.
 */
function resolveLinks(db: Database): void {
	db.transaction(() => {
		db.query(
			`UPDATE links SET target_concept_id = (
				SELECT c.id FROM concepts c WHERE c.path = links.target_path
			)`,
		).run();
	})();
}

/** A concept's bundle-relative directory; the empty string at the bundle root. */
function directoryOf(path: string): string {
	const dir = posix.dirname(path);
	return dir === "." ? "" : dir;
}

/** A concept's OKF identifier: its bundle-relative path without the suffix. */
function identifierOf(path: string): string {
	return path.replace(/\.md$/, "");
}
