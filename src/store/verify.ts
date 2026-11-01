/**
 * Proving an import lost nothing, and that search still answers as it did.
 *
 * The checks read the finished store and compare it with the files it came
 * from, never with the in-memory notes that were written: a note's sections
 * joined back against its file's body, its fields against the frontmatter the
 * library parses on its own, and a set of questions put to today's index and
 * to the store with old notes left out.
 */

import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/open.js";
import type { EmbeddingProvider } from "../embed/provider.js";
import type { EmbedReport } from "../embed/run.js";
import { search } from "../search/search.js";
import type { Prepared } from "./import.js";

/** What one source contributed, counted in the store. */
export interface SetReport {
	notes: number;
	byType: Record<string, number>;
	sections: number;
	passages: number;
	/** Passages holding a vector in the active space. */
	vectors: number;
	links: {
		total: number;
		source: number;
		wikilink: number;
		markdown: number;
		/** Links whose target is not a note: knowledge not written yet. */
		unresolved: number;
	};
	/** Notes whose sections joined back equal their file's body. */
	roundTrip: Check;
	/** Notes whose fields equal their file's parsed frontmatter. */
	fields: Check;
	/** Notes archived on import. */
	archived: number;
}

export interface Check {
	checked: number;
	exact: number;
	/** The first few that were not, with why. */
	mismatches: string[];
}

export interface SearchCheck {
	queries: number;
	/** Queries whose top five notes and their order matched. */
	matched: number;
	differing: Array<{ query: string; index: string[]; store: string[] }>;
}

export interface ImportReport {
	store: string;
	bundle?: SetReport;
	library?: SetReport & { fullText: number; stubs: number };
	/** Passages and notes copied from today's index instead of embedded. */
	copied: { passages: number; notes: number };
	embedding: { passages: number; notes: number; failed: number };
	/** Files whose frontmatter could not be read as OKF, with why. */
	problems: Array<{ name: string; problem: string }>;
	/** What the import added that the files did not say, by library note count. */
	additions: Record<string, number>;
	/**
	 * Today's index against a store of the bundle's notes alone: same passages,
	 * same vectors, so the top five must match.
	 */
	parity?: SearchCheck;
	/**
	 * The same questions against this store with old notes filtered out. When
	 * the library is in, the keyword ranking's statistics (how common a word
	 * is) cover more text, which reorders near-ties, so this can differ from
	 * `parity` without anything being wrong. Informational.
	 */
	parityInStore?: SearchCheck;
	/** With old notes in, each bundle note's title finds that note above every old one. */
	newerFirst?: { checked: number; passed: number; failed: string[] };
	/** True when nothing differs anywhere above. */
	clean: boolean;
}

interface VerifyInput {
	db: Database;
	prepared: Prepared[];
	provider: EmbeddingProvider;
	oldIndexPath?: string;
	/** The parity measured on a store without the library, when this store has it. */
	scratchParity?: SearchCheck;
	questions: string[];
	embedded: EmbedReport;
	copiedConcepts: number;
	copiedPassages: number;
	storePath: string;
	docs?: string;
	library?: string;
}

const MISMATCHES_SHOWN = 10;

export async function verifyImport(input: VerifyInput): Promise<ImportReport> {
	const { db, prepared } = input;
	const space = { model: input.provider.model, dim: input.provider.dim };
	const bundle = prepared.filter((note) => note.source === "docs");
	const library = prepared.filter((note) => note.source === "lattice-1");

	const report: ImportReport = {
		store: input.storePath,
		copied: { passages: input.copiedPassages, notes: input.copiedConcepts },
		embedding: {
			passages: input.embedded.chunks,
			notes: input.embedded.concepts,
			failed: input.embedded.failed,
		},
		problems: prepared
			.filter((note) => note.problem !== undefined)
			.map((note) => ({ name: note.name, problem: note.problem ?? "" })),
		additions: additionCounts(library),
		clean: true,
	};

	if (input.docs !== undefined) {
		report.bundle = setReport(db, bundle, false, space);
	}
	if (input.library !== undefined) {
		const set = setReport(db, library, true, space);
		report.library = {
			...set,
			fullText: library.filter(
				(note) => !note.fields.tags.includes("full-text-lost"),
			).length,
			stubs: library.filter((note) =>
				note.fields.tags.includes("full-text-lost"),
			).length,
		};
	}

	if (input.oldIndexPath !== undefined && bundle.length > 0) {
		const queries = parityQueries(bundle, input.questions);
		const inStore = await compareWithIndex(
			db,
			input.oldIndexPath,
			input.provider,
			queries,
			bundle.map((note) => note.name),
		);
		if (input.scratchParity === undefined) {
			report.parity = inStore;
		} else {
			report.parity = input.scratchParity;
			report.parityInStore = inStore;
		}
	}
	if (library.length > 0 && bundle.length > 0) {
		report.newerFirst = await newerFirst(db, input.provider, bundle);
	}

	report.clean =
		[report.bundle, report.library].every(
			(set) =>
				set === undefined ||
				(set.roundTrip.exact === set.roundTrip.checked &&
					set.fields.exact === set.fields.checked),
		) &&
		(report.parity === undefined ||
			report.parity.matched === report.parity.queries) &&
		(report.newerFirst === undefined ||
			report.newerFirst.passed === report.newerFirst.checked);
	return report;
}

/** Every bundle note's title and description, then the written questions. */
export function parityQueries(
	bundle: Prepared[],
	questions: string[],
): string[] {
	return [
		...bundle.map((note) => note.fields.title),
		...bundle.map((note) => note.fields.description),
		...questions,
	].filter((text): text is string => text !== null && text.trim() !== "");
}

function setReport(
	db: Database,
	notes: Prepared[],
	library: boolean,
	space: { model: string; dim: number },
): SetReport {
	const mine = library
		? "c.identifier LIKE 'v1/%'"
		: "c.identifier NOT LIKE 'v1/%'";
	const count = (sql: string): number =>
		db.query<{ n: number }, []>(sql).get()?.n ?? 0;

	const byType: Record<string, number> = {};
	for (const row of db
		.query<{ type: string; n: number }, []>(
			`SELECT c.type AS type, count(*) AS n FROM concepts c WHERE ${mine} GROUP BY c.type`,
		)
		.all()) {
		byType[row.type] = row.n;
	}

	const links = {
		total: 0,
		source: 0,
		wikilink: 0,
		markdown: 0,
		unresolved: 0,
	};
	for (const row of db
		.query<
			{
				kind: "source" | "wikilink" | "markdown";
				unresolved: number;
				n: number;
			},
			[]
		>(
			`SELECT l.kind AS kind, l.target_concept_id IS NULL AS unresolved, count(*) AS n
			FROM links l JOIN concepts c ON c.id = l.source_concept_id
			WHERE ${mine} GROUP BY l.kind, unresolved`,
		)
		.all()) {
		links.total += row.n;
		links[row.kind] += row.n;
		if (row.unresolved === 1) {
			links.unresolved += row.n;
		}
	}

	return {
		notes: notes.length,
		byType,
		sections: count(
			`SELECT count(*) AS n FROM sections s JOIN concepts c ON c.id = s.concept_id WHERE ${mine}`,
		),
		passages: count(
			`SELECT count(*) AS n FROM chunks ch JOIN concepts c ON c.id = ch.concept_id WHERE ${mine}`,
		),
		vectors:
			db
				.query<{ n: number }, [string, number]>(
					`SELECT count(*) AS n FROM chunk_embeddings e
					JOIN chunks ch ON ch.id = e.chunk_id JOIN concepts c ON c.id = ch.concept_id
					WHERE ${mine} AND e.model = ? AND e.dim = ?`,
				)
				.get(space.model, space.dim)?.n ?? 0,
		links,
		roundTrip: checkText(db, notes),
		fields: checkFields(db, notes),
		archived: notes.filter((note) => note.archived).length,
	};
}

/** Each note's sections joined back against the body of the file it came from. */
function checkText(db: Database, notes: Prepared[]): Check {
	const query = db.query<{ text: string }, [string]>(
		`SELECT s.text FROM sections s JOIN concepts c ON c.id = s.concept_id
		WHERE c.identifier = ? ORDER BY s.position`,
	);
	const check: Check = { checked: notes.length, exact: 0, mismatches: [] };
	for (const note of notes) {
		const joined = query
			.all(note.name)
			.map((row) => row.text)
			.join("");
		if (joined === note.body) {
			check.exact++;
		} else if (check.mismatches.length < MISMATCHES_SHOWN) {
			check.mismatches.push(note.name);
		}
	}
	return check;
}

interface StoredRow {
	type: string | null;
	title: string | null;
	description: string | null;
	status: string | null;
	stale_after: string | null;
	sources: string;
	frontmatter: string | null;
	id: number;
}

/**
 * Each note's stored fields against the frontmatter its file parses to. Every
 * key the file had must come back with the same value; the only extras
 * allowed are what the import is recorded as having added.
 */
function checkFields(db: Database, notes: Prepared[]): Check {
	const row = db.query<StoredRow, [string]>(
		`SELECT id, type, title, description, status, stale_after, sources, frontmatter
		FROM concepts WHERE identifier = ?`,
	);
	const tags = db.query<{ tag: string }, [number]>(
		"SELECT tag FROM tags WHERE concept_id = ? ORDER BY rowid",
	);
	const check: Check = { checked: notes.length, exact: 0, mismatches: [] };

	for (const note of notes) {
		const stored = row.get(note.name);
		const why =
			stored === null
				? "missing from the store"
				: differences(
						note,
						stored,
						tags.all(stored.id).map((entry) => entry.tag),
					);
		if (why === undefined) {
			check.exact++;
		} else if (check.mismatches.length < MISMATCHES_SHOWN) {
			check.mismatches.push(`${note.name}: ${why}`);
		}
	}
	return check;
}

const PROMOTED_TEXT = [
	["type", "type"],
	["title", "title"],
	["description", "description"],
	["status", "status"],
	["stale_after", "stale_after"],
] as const;

function differences(
	note: Prepared,
	stored: StoredRow,
	storedTags: string[],
): string | undefined {
	const expected = note.expected;
	const extra = JSON.parse(stored.frontmatter ?? "{}") as Record<
		string,
		unknown
	>;

	for (const [key, column] of PROMOTED_TEXT) {
		if (!(key in expected)) {
			continue;
		}
		const value = expected[key];
		// A library note's own type moves to a field; the note's type is the library's.
		if (key === "type" && note.added.fields.includes("fields.v1_type")) {
			if (extra.v1_type !== value) {
				return `v1_type is ${JSON.stringify(extra.v1_type)}, the file says ${JSON.stringify(value)}`;
			}
			continue;
		}
		// A scalar the file wrote as a number or a date is stored as its text.
		if (value === null || String(value) !== stored[column]) {
			return `${key} is ${JSON.stringify(stored[column])}, the file says ${JSON.stringify(value)}`;
		}
	}

	if ("tags" in expected) {
		const wrote = [
			...new Set(
				[expected.tags]
					.flat()
					.map((tag) => String(tag).trim())
					.filter((tag) => tag !== ""),
			),
		];
		const want = [
			...wrote,
			...note.added.tags.filter((tag) => !wrote.includes(tag)),
		];
		if (JSON.stringify(storedTags) !== JSON.stringify(want)) {
			return `tags are ${JSON.stringify(storedTags)}, the file says ${JSON.stringify(expected.tags)}`;
		}
	} else if (JSON.stringify(storedTags) !== JSON.stringify(note.added.tags)) {
		return `tags are ${JSON.stringify(storedTags)}, the file has none`;
	}

	if ("sources" in expected) {
		const wrote = [expected.sources].flat();
		if (JSON.stringify(wrote) !== stored.sources) {
			return "sources differ";
		}
	} else if (stored.sources !== "[]") {
		return "sources appeared";
	}

	const promoted = new Set<string>([
		...PROMOTED_TEXT.map(([key]) => key),
		"tags",
		"sources",
	]);
	for (const [key, value] of Object.entries(expected)) {
		if (
			!promoted.has(key) &&
			JSON.stringify(value) !== JSON.stringify(extra[key])
		) {
			return `${key} differs`;
		}
	}
	for (const key of Object.keys(extra)) {
		if (!(key in expected) && !note.added.fields.includes(`fields.${key}`)) {
			return `${key} appeared`;
		}
	}
	for (const [key, column] of PROMOTED_TEXT) {
		if (
			!(key in expected) &&
			stored[column] !== null &&
			!note.added.fields.includes(key)
		) {
			return `${key} appeared`;
		}
	}
	return undefined;
}

function additionCounts(library: Prepared[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const note of library) {
		for (const field of note.added.fields) {
			counts[field] = (counts[field] ?? 0) + 1;
		}
		for (const tag of note.added.tags) {
			counts[`tag ${tag}`] = (counts[`tag ${tag}`] ?? 0) + 1;
		}
	}
	return counts;
}

/** The notes a search answered with, the direct ones only, best first. */
async function topNotes(
	db: Database,
	provider: EmbeddingProvider,
	query: string,
	filters: { notes?: string[] },
	limit: number,
): Promise<string[]> {
	const [vector] = await provider.embedQuery([query]);
	const result = await search(db, {
		query,
		limit,
		chunksPerConcept: 2,
		asOf: Date.now(),
		expand: 0,
		candidates: Math.max(20, limit),
		semantic: { vector, model: provider.model, dim: provider.dim },
		...filters,
	});
	return result.hits.map((hit) => hit.identifier);
}

/**
 * Today's index and the store, asked the same things over the bundle's notes
 * alone. Passages and vectors are the same text, so any difference is a bug.
 */
async function compareWithIndex(
	db: Database,
	oldIndexPath: string,
	provider: EmbeddingProvider,
	queries: string[],
	names: string[],
): Promise<SearchCheck> {
	const old = openDatabase(oldIndexPath);
	const check: SearchCheck = {
		queries: queries.length,
		matched: 0,
		differing: [],
	};
	try {
		for (const query of queries) {
			const index = await topNotes(old, provider, query, {}, 5);
			const store = await topNotes(db, provider, query, { notes: names }, 5);
			if (JSON.stringify(index) === JSON.stringify(store)) {
				check.matched++;
			} else if (check.differing.length < MISMATCHES_SHOWN) {
				check.differing.push({ query, index, store });
			}
		}
	} finally {
		old.close();
	}
	return check;
}

/** With old notes in the store, a bundle note's title finds it ahead of every old note. */
async function newerFirst(
	db: Database,
	provider: EmbeddingProvider,
	bundle: Prepared[],
): Promise<NonNullable<ImportReport["newerFirst"]>> {
	const out = { checked: 0, passed: 0, failed: [] as string[] };
	for (const note of bundle) {
		if (note.fields.title === null) {
			continue;
		}
		out.checked++;
		const found = await topNotes(db, provider, note.fields.title, {}, 10);
		const own = found.indexOf(note.name);
		const firstOld = found.findIndex((name) => name.startsWith("v1/"));
		if (own !== -1 && (firstOld === -1 || own < firstOld)) {
			out.passed++;
		} else {
			out.failed.push(note.name);
		}
	}
	return out;
}

/** The report as text, for the command line. */
export function renderReport(report: ImportReport): string {
	const lines = [`Imported into ${report.store}`, ""];
	const section = (title: string, set: SetReport): void => {
		lines.push(
			`${title}: ${set.notes} notes (${Object.entries(set.byType)
				.map(([type, n]) => `${n} ${type}`)
				.join(
					", ",
				)}), ${set.sections} sections, ${set.passages} passages, ${set.vectors} with vectors`,
			`  links: ${set.links.total} (${set.links.source} sources, ${set.links.wikilink} wikilinks, ${set.links.markdown} markdown), ${set.links.unresolved} to notes not written yet`,
			`  text joined back equals the file: ${set.roundTrip.exact} of ${set.roundTrip.checked}`,
			`  fields equal the frontmatter: ${set.fields.exact} of ${set.fields.checked}`,
		);
		if (set.archived > 0) {
			lines.push(`  archived on import: ${set.archived}`);
		}
		for (const name of set.roundTrip.mismatches) {
			lines.push(`  text differs: ${name}`);
		}
		for (const why of set.fields.mismatches) {
			lines.push(`  fields differ: ${why}`);
		}
	};
	if (report.bundle) {
		section("Bundle", report.bundle);
	}
	if (report.library) {
		section("Lattice 1", report.library);
		lines.push(
			`  ${report.library.fullText} with full text, ${report.library.stubs} whose full text is lost`,
			`  added by the import: ${Object.entries(report.additions)
				.map(([key, n]) => `${key} x${n}`)
				.join(", ")}`,
		);
	}
	lines.push(
		"",
		`Vectors copied from today's index: ${report.copied.passages} passages, ${report.copied.notes} notes`,
		`Embedded now: ${report.embedding.passages} passages, ${report.embedding.notes} notes${report.embedding.failed > 0 ? `, ${report.embedding.failed} failed` : ""}`,
	);
	if (report.parity) {
		lines.push(
			`Search against today's index (bundle notes only): ${report.parity.matched} of ${report.parity.queries} queries give the same top five`,
		);
		for (const entry of report.parity.differing) {
			lines.push(
				`  differs: ${entry.query.slice(0, 60)}`,
				`    index: ${entry.index.join(", ")}`,
				`    store: ${entry.store.join(", ")}`,
			);
		}
	}
	if (report.parityInStore) {
		lines.push(
			`  (in this store with old notes filtered out: ${report.parityInStore.matched} of ${report.parityInStore.queries}; the library changes keyword statistics, which reorders near-ties)`,
		);
	}
	if (report.newerFirst) {
		lines.push(
			`Newer first: ${report.newerFirst.passed} of ${report.newerFirst.checked} bundle titles find their own note above every old note`,
		);
		for (const name of report.newerFirst.failed) {
			lines.push(`  not first: ${name}`);
		}
	}
	if (report.problems.length > 0) {
		lines.push("", `Frontmatter problems (${report.problems.length}):`);
		for (const problem of report.problems.slice(0, 10)) {
			lines.push(`  ${problem.name}: ${problem.problem}`);
		}
		if (report.problems.length > 10) {
			lines.push(`  and ${report.problems.length - 10} more`);
		}
	}
	lines.push(
		"",
		report.clean ? "Nothing differs." : "SOMETHING DIFFERS: do not cut over.",
	);
	return `${lines.join("\n")}\n`;
}
