import type { Database, SQLQueryBindings } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { listConceptFiles } from "../../okf/bundle.js";
import { chunkConcept } from "../../okf/chunk.js";
import { parseConcept } from "../../okf/concept.js";
import { hashContent } from "../../okf/hash.js";
import { acquireLock, LockHeldError } from "../../okf/lock.js";
import {
	type FileWithHash,
	type IndexedConcept,
	planSync,
} from "../../okf/plan.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Index the bundle.
 *
 * Every file is hashed on every run and each document is committed in its own
 * transaction, so an interrupted sync leaves a readable index and the next run
 * picks up exactly the documents that are still out of date. A document whose
 * hash already matches is not touched at all.
 */
export function runSync(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database) || !existsSync(paths.docs)) {
		return {
			code: 1,
			stderr: `No Lattice bundle at ${paths.docs}. Run \`lattice init\` first.`,
		};
	}

	let lock: { release(): void };
	try {
		lock = acquireLock(paths.lock);
	} catch (error) {
		if (error instanceof LockHeldError) {
			return { code: 1, stderr: error.message };
		}
		throw error;
	}

	const db = openDatabase(paths.database);
	try {
		const files = readBundle(paths.docs);
		const plan = planSync(files, readIndexedConcepts(db));

		for (const file of plan.added) {
			transact(db, () => insertConcept(db, file));
		}
		for (const { conceptId, file } of plan.changed) {
			transact(db, () => {
				deleteConcept(db, conceptId);
				insertConcept(db, file);
			});
		}
		for (const rename of plan.renamed) {
			transact(db, () => {
				db.query(
					"UPDATE concepts SET path = ?, directory = ? WHERE id = ?",
				).run(rename.file.path, rename.file.directory, rename.conceptId);
			});
		}
		for (const concept of plan.deleted) {
			transact(db, () => deleteConcept(db, concept.id));
		}

		const parts = [
			`${plan.added.length} new`,
			`${plan.changed.length} changed`,
			`${plan.deleted.length} deleted`,
		];
		if (plan.renamed.length > 0) {
			parts.push(`${plan.renamed.length} renamed`);
		}

		return {
			code: 0,
			stdout: `${parts.join(", ")}. ${plan.unchanged} unchanged.\n`,
		};
	} finally {
		db.close();
		lock.release();
	}
}

/** Every concept file in the bundle, with its content hash. */
export function readBundle(docs: string): FileWithHash[] {
	return listConceptFiles(docs).map((file) => ({
		...file,
		contentHash: hashContent(readFileSync(file.absolutePath, "utf8")),
	}));
}

/** What the index already holds, for the diff. */
export function readIndexedConcepts(db: Database): IndexedConcept[] {
	return db
		.query<{ id: number; path: string; content_hash: string }, []>(
			"SELECT id, path, content_hash FROM concepts",
		)
		.all()
		.map((row) => ({
			id: row.id,
			path: row.path,
			contentHash: row.content_hash,
		}));
}

/**
 * Run one document's writes as a transaction, so an interruption can only
 * ever land between documents.
 */
function transact(db: Database, work: () => void): void {
	db.transaction(work)();
}

/** Remove a concept and, by cascade, its chunks, tags and embeddings. */
function deleteConcept(db: Database, conceptId: number): void {
	db.query("DELETE FROM concepts WHERE id = ?").run(conceptId);
}

function insertConcept(db: Database, file: FileWithHash): void {
	const text = readFileSync(file.absolutePath, "utf8");
	const concept = parseConcept(text, basename(file.path));

	const inserted = db
		.query<{ id: number }, SQLQueryBindings[]>(
			`INSERT INTO concepts (
				path, directory, title, type, description, status, stale_after,
				trust_level, content_hash, frontmatter, frontmatter_error,
				byte_size, mtime_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.get(
			file.path,
			file.directory,
			concept.title,
			concept.type,
			concept.description,
			concept.status,
			concept.staleAfter,
			concept.trustLevel,
			file.contentHash,
			concept.frontmatter === null ? null : JSON.stringify(concept.frontmatter),
			concept.frontmatterError,
			file.byteSize,
			file.mtimeMs,
		);

	if (inserted === null) {
		throw new Error(`Failed to index ${file.path}.`);
	}

	const insertTag = db.query(
		"INSERT INTO concept_tags (concept_id, tag) VALUES (?, ?)",
	);
	for (const tag of concept.tags) {
		insertTag.run(inserted.id, tag);
	}

	const insertChunk = db.query(
		`INSERT INTO chunks (
			concept_id, ordinal, heading, heading_path, depth,
			start_line, end_line, start_char, end_char,
			content, content_hash, token_estimate
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const chunks = chunkConcept({
		body: concept.body,
		bodyCharOffset: concept.bodyCharOffset,
		bodyStartLine: concept.bodyStartLine,
		title: concept.title,
	});
	for (const chunk of chunks) {
		insertChunk.run(
			inserted.id,
			chunk.ordinal,
			chunk.heading,
			chunk.headingPath,
			chunk.depth,
			chunk.startLine,
			chunk.endLine,
			chunk.startChar,
			chunk.endChar,
			chunk.indexedText,
			hashContent(chunk.indexedText),
			chunk.tokenEstimate,
		);
	}
}

/** The filename without its directory or `.md` suffix. */
function basename(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}
