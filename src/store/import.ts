/**
 * Importing notes into a fresh store.
 *
 * Two sources, read with today's frontmatter reader and never written to:
 *
 * - **The bundle** (`docs/`): each file becomes a note under the name its path
 *   gives it, its frontmatter becomes the note's fields, its body becomes
 *   sections. Its passage and note vectors are copied from today's index
 *   wherever the text is identical, so these embed nothing.
 * - **Lattice 1's library** (`archive/v1`): every `.md` under its `docs/` and
 *   `lost/`, `index.md` included, becomes a note named `v1/` plus its path.
 *   They have no type, so they get `Lattice 1`. Each is marked old (a tag, and
 *   a stale-after date in the past, which search already demotes), and a stub
 *   whose text is gone is marked `full-text-lost`. The two generated title
 *   lists at the top of the library are kept but archived, so they do not crowd
 *   answers.
 *
 * The store is built in a work file of its own beside its final path and linked
 * into place only when everything, the embedding included, has finished and
 * verified clean, so a stopped import leaves nothing behind and a store that
 * did not verify is kept as `store.db.failed`, never as `store.db`.
 */

import type { Database } from "bun:sqlite";
import {
	copyFileSync,
	existsSync,
	linkSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join, posix, sep } from "node:path";
import matter from "gray-matter";
import { openDatabase } from "../db/open.js";
import type { EmbeddingProvider } from "../embed/provider.js";
import { CONCEPTS, embedPending } from "../embed/run.js";
import { readActiveSpace, writeActiveSpace } from "../embed/state.js";
import { NO_TYPE, normalizeDates, parseConcept } from "../sync/okf.js";
import { scanBundle } from "../sync/scan.js";
import { workPath } from "../utils/paths.js";
import { carryKey, resolveLinks, type StoredVector } from "./derive.js";
import { EXPORT_MARK } from "./export.js";
import { openStore } from "./open.js";
import { splitSections } from "./sections.js";
import { createNote, type NoteFields } from "./store.js";
import { type ImportReport, type SearchCheck, verifyImport } from "./verify.js";

/** The type every note of Lattice 1's library is given: it had none. */
export const OLD_TYPE = "Lattice 1";
/** Marks a note as old, to be outranked by newer research. */
export const OLD_TAG = "old";
/** Marks a stub that kept a summary and lost its text. */
export const LOST_TAG = "full-text-lost";
/** Notes of the library are named under this folder. */
export const OLD_PREFIX = "v1/";
/**
 * When Lattice 1's text was last built (its site, 2026-02-22) and when it last
 * indexed a stub (2026-08-05). A note is stale once this date is behind it,
 * which every one is, and search halves the score of a stale note.
 */
const OLD_STALE_AFTER = "2026-02-22";
const LOST_STALE_AFTER = "2026-08-05";
/** The library's generated title lists, kept archived. */
const GENERATED = new Set(["README", "welcome"]);

export interface ImportInput {
	/** Where the finished store goes. It must not exist. */
	storePath: string;
	/** Today's bundle, or none. */
	docs?: string;
	/** Lattice 1's library root (holding `docs/` and `lost/`), or none. */
	library?: string;
	/** Today's index, whose vectors are copied when it is in the provider's space. */
	oldIndex?: string;
	provider: EmbeddingProvider;
	report: (line: string) => void;
	/** The instant the import is dated. Defaults to now. */
	at?: string;
	/** Questions to put to both searches besides the notes' titles and descriptions. */
	questions?: string[];
	/**
	 * A seam for tests: called on the built store just before it is verified,
	 * so a test can damage it and watch the verification refuse it.
	 */
	beforeVerify?: (db: Database) => void;
}

/** A source file read and prepared, before it is a note. */
export interface Prepared {
	source: "docs" | "lattice-1";
	name: string;
	origin: string;
	body: string;
	fields: NoteFields;
	archived: boolean;
	/** The frontmatter as parsed on its own, for comparing against the note. */
	expected: Record<string, unknown>;
	/** What the import added that the file did not say. */
	added: { tags: string[]; fields: string[] };
	problem?: string;
}

export async function importNotes(input: ImportInput): Promise<ImportReport> {
	if (existsSync(input.storePath)) {
		throw new Error(
			`A store already exists at ${input.storePath}. Import builds a fresh one: move it aside first.`,
		);
	}
	if (input.docs === undefined && input.library === undefined) {
		throw new Error("Nothing to import: give a bundle, a library, or both.");
	}

	const at = input.at ?? new Date().toISOString();
	const prepared: Prepared[] = [
		...(input.docs === undefined ? [] : readBundle(input.docs)),
		...(input.library === undefined ? [] : readLibrary(input.library)),
	];
	const names = new Set<string>();
	for (const note of prepared) {
		if (names.has(note.name)) {
			throw new Error(`Two sources would both make the note ${note.name}.`);
		}
		names.add(note.name);
	}

	// Search parity is measured on the bundle alone: adding the library
	// changes the keyword statistics and reorders near-ties, which is not a
	// fault in the import. The same notes are built once more, small, to
	// measure on.
	let scratchParity: SearchCheck | undefined;
	if (
		input.docs !== undefined &&
		input.library !== undefined &&
		input.oldIndex !== undefined &&
		existsSync(input.oldIndex)
	) {
		const scratch = workPath(input.storePath, "parity");
		try {
			scratchParity = (
				await importNotes({
					...input,
					library: undefined,
					storePath: scratch,
					report: () => undefined,
					beforeVerify: undefined,
				})
			).parity;
		} finally {
			removeStore(scratch);
			removeStore(`${scratch}.failed`);
		}
	}

	const building = workPath(input.storePath, "importing");
	const db = openStore(building, { create: true });
	let report: ImportReport;
	try {
		const space = { model: input.provider.model, dim: input.provider.dim };
		writeActiveSpace(db, space);

		const copied = copyVectors(input, space);
		input.report(
			copied === undefined
				? "No usable vectors in today's index to copy; every passage will be embedded."
				: `Copying vectors from today's index (${copied.passages.size} passage texts).`,
		);

		for (const note of prepared) {
			createNote(
				db,
				{
					name: note.name,
					fields: note.fields,
					sections: splitSections(note.body),
					archived: note.archived,
				},
				{
					kind: "import",
					reason: `imported from ${note.source === "docs" ? "the bundle" : "Lattice 1's library"} (${note.origin}) on ${at.slice(0, 10)}`,
					who: { client: "lattice import" },
					at,
					carry: copied?.passages,
					resolve: false,
				},
			);
		}
		resolveLinks(db);
		input.report(`Wrote ${prepared.length} notes.`);

		const copiedPassages = vectorCount(db);
		const copiedConcepts = copied
			? copyConceptVectors(db, copied.conceptVectors)
			: 0;

		input.report("Embedding what has no vector yet.");
		const embedded = await embedPending(db, input.provider);

		input.beforeVerify?.(db);
		report = await verifyImport({
			db,
			prepared,
			provider: input.provider,
			oldIndexPath: copied === undefined ? undefined : input.oldIndex,
			scratchParity,
			questions: input.questions ?? [],
			embedded,
			copiedConcepts,
			copiedPassages,
			storePath: input.storePath,
			docs: input.docs,
			library: input.library,
		});
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch (error) {
		db.close();
		removeStore(building);
		throw error;
	}
	db.close();

	// A store that did not verify never takes the live path: a rerun would
	// refuse it, and nothing should read it. It is kept for inspection.
	if (!report.clean) {
		const failed = `${input.storePath}.failed`;
		removeStore(failed);
		copyFileSync(building, failed);
		removeStore(building);
		report.failedAt = failed;
		return report;
	}

	// The checkpoint above left everything in the main file. It is copied, not
	// renamed: the embed phase can leave this connection's handle open until
	// the process lets go of it, and a file renamed under an open handle makes
	// the next open of its new name fail in the same process. Linking it into
	// place refuses if another import got there first.
	const finished = workPath(input.storePath, "copying");
	copyFileSync(building, finished);
	removeStore(building);
	try {
		linkSync(finished, input.storePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(
				`A store appeared at ${input.storePath} while this import ran, and was left alone. Move it aside and import again.`,
			);
		}
		throw error;
	} finally {
		rmSync(finished, { force: true });
	}
	return report;
}

/** An export is a copy of the store; reading it back would make two sources of truth. */
function refuseExport(raw: string, origin: string): void {
	if (raw.startsWith(`---\n${EXPORT_MARK}\n`)) {
		throw new Error(
			`${origin} is an export of the note store, a copy that Lattice never reads back. Import the original files, not an export.`,
		);
	}
}

function removeStore(path: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(`${path}${suffix}`, { force: true });
	}
}

/** Today's bundle: every file the scanner takes, named by its path. */
function readBundle(root: string): Prepared[] {
	return scanBundle(root).map((file) => {
		const raw = readFileSync(file.absolutePath, "utf8");
		refuseExport(raw, file.path);
		const concept = parseConcept(raw);
		const { sources: _sources, ...extra } = concept.rest;
		return {
			source: "docs" as const,
			name: file.path.replace(/\.md$/, ""),
			origin: file.path,
			body: concept.body,
			fields: {
				type: concept.type ?? "Note",
				title: concept.title ?? null,
				description: concept.description ?? null,
				status: concept.status ?? null,
				staleAfter: concept.staleAfter ?? null,
				tags: concept.tags,
				sources: concept.sources,
				extra,
			},
			archived: false,
			expected: rawFrontmatter(raw),
			// A file whose frontmatter cannot be read has no type; it is filed as a plain note.
			added: { tags: [], fields: concept.type === undefined ? ["type"] : [] },
			problem: concept.problem,
		};
	});
}

/** Lattice 1's library: every markdown file under `docs/` and `lost/`. */
function readLibrary(root: string): Prepared[] {
	const out: Prepared[] = [];
	for (const [folder, lost] of [
		["docs", false],
		["lost", true],
	] as const) {
		for (const path of walk(join(root, folder), "").sort()) {
			const raw = readFileSync(join(root, folder, ...path.split("/")), "utf8");
			refuseExport(raw, `${folder}/${path}`);
			out.push(prepareOld(raw, path, lost, `${folder}/${path}`));
		}
	}
	return out;
}

function prepareOld(
	raw: string,
	path: string,
	lost: boolean,
	origin: string,
): Prepared {
	const concept = parseConcept(raw);
	const { sources: _sources, ...rest } = concept.rest;
	const extra: Record<string, unknown> = { ...rest };
	const added = { tags: [OLD_TAG], fields: ["type", "stale_after"] } as {
		tags: string[];
		fields: string[];
	};
	// A type the file did have is not thrown away.
	if (concept.type !== undefined) {
		extra.v1_type = concept.type;
		added.fields.push("fields.v1_type");
	}
	if (lost) {
		added.tags.push(LOST_TAG);
	}

	const name = `${OLD_PREFIX}${path.replace(/\.md$/, "")}`;
	let title = concept.title ?? null;
	if (title === null) {
		title = firstHeading(concept.body) ?? posix.basename(path, ".md");
		added.fields.push("title");
	}
	// A status the file did not have stays empty: "archived" would be confused
	// with the flag that hides a note.
	const status = concept.status ?? null;

	return {
		source: "lattice-1",
		name,
		origin,
		body: concept.body,
		fields: {
			type: OLD_TYPE,
			title,
			description: concept.description ?? null,
			status,
			staleAfter: lost ? LOST_STALE_AFTER : OLD_STALE_AFTER,
			tags: [...new Set([...concept.tags, ...added.tags])],
			sources: concept.sources,
			extra,
		},
		// Kept, but out of the way: these two are lists of titles.
		archived: !lost && GENERATED.has(path.replace(/\.md$/, "")),
		expected: rawFrontmatter(raw),
		added,
		// The library has no types; the import gives them one.
		problem: concept.problem === NO_TYPE ? undefined : concept.problem,
	};
}

function firstHeading(body: string): string | null {
	const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body);
	return match === null ? null : match[1];
}

/** Every `.md` under `root`, as paths relative to it with forward slashes. */
function walk(root: string, relative: string): string[] {
	if (!existsSync(root)) {
		return [];
	}
	const out: string[] = [];
	for (const entry of readdirSync(join(root, ...relative.split("/")), {
		withFileTypes: true,
	})) {
		if (entry.name.startsWith(".")) {
			continue;
		}
		const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) {
			out.push(...walk(root, child));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			out.push(child.split(sep).join("/"));
		}
	}
	return out;
}

/** The frontmatter of a file, parsed by the library alone, dates as ISO text. */
function rawFrontmatter(raw: string): Record<string, unknown> {
	try {
		const data = matter(raw, {}).data;
		return normalizeDates(data) as Record<string, unknown>;
	} catch {
		return {};
	}
}

interface CopiedVectors {
	passages: Map<string, StoredVector[]>;
	/** Note vectors by the text they were made from. */
	conceptVectors: Map<string, StoredVector[]>;
}

/**
 * Vectors from today's index, by the text each was made from, when that index
 * is in the vector space the import will embed in. Anything else would mix
 * two spaces.
 */
function copyVectors(
	input: ImportInput,
	space: { model: string; dim: number },
): CopiedVectors | undefined {
	if (input.oldIndex === undefined || !existsSync(input.oldIndex)) {
		return undefined;
	}
	const old = openDatabase(input.oldIndex);
	try {
		const active = readActiveSpace(old);
		if (
			active === undefined ||
			active.model !== space.model ||
			active.dim !== space.dim
		) {
			return undefined;
		}

		const passages = new Map<string, StoredVector[]>();
		for (const row of old
			.query<
				{
					heading_path: string | null;
					content_hash: string;
					model: string;
					dim: number;
					vector: Uint8Array;
				},
				[string, number]
			>(
				`SELECT ch.heading_path, ch.content_hash, e.model, e.dim, e.vector
				FROM chunk_embeddings e JOIN chunks ch ON ch.id = e.chunk_id
				WHERE e.model = ? AND e.dim = ?`,
			)
			.all(space.model, space.dim)) {
			passages.set(carryKey(row.heading_path ?? "", row.content_hash), [
				{ model: row.model, dim: row.dim, vector: row.vector },
			]);
		}

		const conceptVectors = new Map<string, StoredVector[]>();
		for (const row of old
			.query<
				{ text: string; model: string; dim: number; vector: Uint8Array },
				[string, number]
			>(
				`SELECT ${CONCEPT_TEXT} AS text, e.model, e.dim, e.vector
				FROM concept_embeddings e JOIN concepts t ON t.id = e.concept_id
				WHERE e.model = ? AND e.dim = ?`,
			)
			.all(space.model, space.dim)) {
			conceptVectors.set(row.text, [
				{ model: row.model, dim: row.dim, vector: row.vector },
			]);
		}
		return { passages, conceptVectors };
	} finally {
		old.close();
	}
}

/**
 * What a note's own vector is made from: the expression `embed` uses, with `t`
 * the concept row, so a copied vector is one the embed phase would have made.
 */
const CONCEPT_TEXT = CONCEPTS.text;

/** Give each note the vector of today's index for its title, description and tags, when the text is the same. */
function copyConceptVectors(
	db: Database,
	vectors: Map<string, StoredVector[]>,
): number {
	let copied = 0;
	const insert = db.query(
		"INSERT INTO concept_embeddings (concept_id, model, dim, vector) VALUES (?, ?, ?, ?)",
	);
	db.transaction(() => {
		for (const row of db
			.query<{ id: number; text: string }, []>(
				`SELECT t.id AS id, ${CONCEPT_TEXT} AS text FROM concepts t`,
			)
			.all()) {
			const held = vectors.get(row.text);
			if (held === undefined) {
				continue;
			}
			for (const vector of held) {
				insert.run(row.id, vector.model, vector.dim, vector.vector);
			}
			copied++;
		}
	})();
	return copied;
}

function vectorCount(db: Database): number {
	return (
		db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM chunk_embeddings")
			.get()?.n ?? 0
	);
}
