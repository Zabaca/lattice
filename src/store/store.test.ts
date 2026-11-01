import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "../db/open.js";
import { openStore } from "./open.js";
import { isRefusal, readNote } from "./read.js";
import { splitSections } from "./sections.js";
import { changeNote, createNote, type NoteFields } from "./store.js";
import { freshHome } from "./testing.js";

describe("splitSections", () => {
	test("cuts a body at every heading line, of any depth, heading included", () => {
		const body =
			"# Title\n\nIntro.\n\n## A\n\nText a.\n\n### A1\n\nDeep.\n\n## B\n\nText b.\n";

		const sections = splitSections(body);

		expect(sections.map((s) => [s.depth, s.heading])).toEqual([
			[1, "Title"],
			[2, "A"],
			[3, "A1"],
			[2, "B"],
		]);
		expect(sections[1].text).toBe("## A\n\nText a.\n\n");
		expect(sections.map((s) => s.text).join("")).toBe(body);
	});

	test("a heading inside a fenced code block does not start a section", () => {
		const body =
			"# T\n\n```sh\n# a comment, not a heading\n```\n\n## Next\n\nx\n";

		const sections = splitSections(body);

		expect(sections.map((s) => s.heading)).toEqual(["T", "Next"]);
		expect(sections[0].text).toContain("# a comment, not a heading");
	});

	test("whitespace above the first heading belongs to that heading's section", () => {
		const sections = splitSections("\n# Title\n\nBody.\n");

		expect(sections).toHaveLength(1);
		expect(sections[0].text).toBe("\n# Title\n\nBody.\n");
	});

	test("text above the first heading is a lead section of its own, with no heading", () => {
		const sections = splitSections(
			"A paragraph before any heading.\n\n## First\n\nx\n",
		);

		expect(sections.map((s) => [s.depth, s.heading])).toEqual([
			[0, null],
			[2, "First"],
		]);
		expect(sections[0].text).toBe("A paragraph before any heading.\n\n");
	});

	test("a body with no heading at all is one section, and an empty body is none", () => {
		expect(splitSections("just text\n")).toEqual([
			{ heading: null, depth: 0, text: "just text\n" },
		]);
		expect(splitSections("")).toEqual([]);
	});
});

const FIELDS: NoteFields = {
	type: "Topic",
	title: "Demo",
	description: "A demonstration note.",
	status: "draft",
	staleAfter: null,
	tags: ["demo"],
	sources: [],
	extra: {},
};

const BODY = "# Demo\n\nIntro.\n\n## Findings\n\n- one\n\n## Sources\n\n- a\n";

function seeded() {
	const db = openStore(join(freshHome(), "store.db"), { create: true });
	const created = createNote(
		db,
		{ name: "topic/demo", fields: FIELDS, sections: splitSections(BODY) },
		{ kind: "create", who: { client: "test" }, at: "2026-11-01T10:00:00.000Z" },
	);
	return { db, created };
}

describe("changes to a note", () => {
	test("each change makes the next version, and every version can be read back", () => {
		const { db, created } = seeded();
		expect(created.version).toBe(1);

		// v2: one section's text and the title.
		changeNote(db, created.conceptId, {
			kind: "edit",
			who: { client: "test" },
			at: "2026-11-01T11:00:00.000Z",
			sections: [
				{ op: "update", sid: "s2", text: "## Findings\n\n- one\n- two\n\n" },
			],
			fields: { title: "Demo, revised" },
		});
		// v3: a new section after s2, and s3 removed.
		changeNote(db, created.conceptId, {
			kind: "edit",
			who: { client: "test" },
			at: "2026-11-01T12:00:00.000Z",
			sections: [
				{
					op: "insert",
					after: "s2",
					depth: 2,
					heading: "Method",
					text: "## Method\n\nHow.\n\n",
				},
				{ op: "remove", sid: "s3" },
			],
		});
		// v4: the new section moves to the front.
		const last = changeNote(db, created.conceptId, {
			kind: "edit",
			who: { client: "test" },
			at: "2026-11-01T13:00:00.000Z",
			sections: [{ op: "move", sid: "s4", after: null }],
		});
		expect(last.version).toBe(4);

		const joined = (version?: number) => {
			const read = readNote(db, "topic/demo", { version });
			if (isRefusal(read)) {
				throw new Error(read.refused);
			}
			return { text: read.text.map((t) => t.text).join(""), read };
		};

		expect(joined(1).text).toBe(BODY);
		expect(joined(1).read.title).toBe("Demo");
		expect(joined(2).text).toBe(
			"# Demo\n\nIntro.\n\n## Findings\n\n- one\n- two\n\n## Sources\n\n- a\n",
		);
		expect(joined(2).read.title).toBe("Demo, revised");
		expect(joined(3).text).toBe(
			"# Demo\n\nIntro.\n\n## Findings\n\n- one\n- two\n\n## Method\n\nHow.\n\n",
		);
		expect(joined(4).text).toBe(
			"## Method\n\nHow.\n\n# Demo\n\nIntro.\n\n## Findings\n\n- one\n- two\n\n",
		);
		expect(joined().read.version).toBe(4);
		expect(joined(1).read.as_of_version).toBe(1);
	});

	test("a section a change touches is unchecked again and its version rises; the others keep theirs", () => {
		const { db, created } = seeded();
		db.query(
			"UPDATE sections SET trust = 'human-reviewed', checked_by = 'james' WHERE sid IN ('s1', 's2')",
		).run();

		changeNote(db, created.conceptId, {
			kind: "edit",
			who: {},
			sections: [
				{ op: "update", sid: "s2", text: "## Findings\n\n- changed\n\n" },
			],
		});

		const read = readNote(db, "topic/demo");
		if (isRefusal(read)) {
			throw new Error(read.refused);
		}
		expect(read.outline.map((s) => [s.id, s.checked, s.version])).toEqual([
			["s1", "james", 1],
			["s2", "unchecked", 2],
			["s3", "unchecked", 1],
		]);
		expect(read.checked).toBe(1);
	});

	test("a section touched twice in one change is recorded once, from what it was to what it became", () => {
		const { db, created } = seeded();

		const result = changeNote(db, created.conceptId, {
			kind: "edit",
			who: {},
			sections: [
				{ op: "update", sid: "s2", text: "## Findings\n\n- first\n\n" },
				{ op: "update", sid: "s2", text: "## Findings\n\n- second\n\n" },
			],
		});

		const rows = db
			.query<{ before_text: string; after_text: string }, [number]>(
				"SELECT before_text, after_text FROM change_sections WHERE change_id = ?",
			)
			.all(result.changeId);
		expect(rows).toEqual([
			{
				before_text: "## Findings\n\n- one\n\n",
				after_text: "## Findings\n\n- second\n\n",
			},
		]);
	});

	test("a section removed is never numbered again", () => {
		const { db, created } = seeded();
		changeNote(db, created.conceptId, {
			kind: "edit",
			who: {},
			sections: [{ op: "remove", sid: "s3" }],
		});

		changeNote(db, created.conceptId, {
			kind: "edit",
			who: {},
			sections: [
				{
					op: "insert",
					after: "s2",
					depth: 2,
					heading: "New",
					text: "## New\n\nx\n",
				},
			],
		});

		const read = readNote(db, "topic/demo");
		if (isRefusal(read)) {
			throw new Error(read.refused);
		}
		expect(read.outline.map((s) => s.id)).toEqual(["s1", "s2", "s4"]);
	});

	test("a change rebuilds the note's passages, and a passage whose text did not change keeps its vector", () => {
		const { db, created } = seeded();
		const vectors = () =>
			db
				.query<{ n: number }, []>("SELECT count(*) AS n FROM chunk_embeddings")
				.get()?.n;
		const chunkId = db
			.query<{ id: number }, []>(
				"SELECT id FROM chunks WHERE concept_id = 1 LIMIT 1",
			)
			.get()?.id;
		db.query(
			"INSERT INTO chunk_embeddings (chunk_id, model, dim, vector) VALUES (?, 'm', 2, x'0000803f00000000')",
		).run(chunkId ?? 0);
		expect(vectors()).toBe(1);

		// A change to the title does not touch any passage's text.
		const result = changeNote(db, created.conceptId, {
			kind: "edit",
			who: {},
			fields: { title: "Renamed" },
		});

		expect(result.carried).toBe(1);
		expect(vectors()).toBe(1);
	});

	test("a field change leaves the old note vector describing something else, so it is dropped", () => {
		const { db, created } = seeded();
		db.query(
			"INSERT INTO concept_embeddings (concept_id, model, dim, vector) VALUES (?, 'm', 2, x'0000803f00000000')",
		).run(created.conceptId);

		changeNote(db, created.conceptId, {
			kind: "edit",
			who: {},
			fields: { description: "Different." },
		});

		expect(
			db
				.query<{ n: number }, []>(
					"SELECT count(*) AS n FROM concept_embeddings",
				)
				.get()?.n,
		).toBe(0);
	});

	test("asking for a version the note never had is refused and says what versions exist", () => {
		const { db } = seeded();

		const read = readNote(db, "topic/demo", { version: 7 });

		expect(read).toEqual({
			refused: "topic/demo has no version 7; its versions run from 1 to 1.",
			next: "Use history with the note's name to see its versions.",
		});
	});
});

describe("the store's file", () => {
	test("its layout is pinned: a change to the index's schema that would change the store shows up here", () => {
		const db = openStore(join(freshHome(), "store.db"), { create: true });
		const columns = (table: string) =>
			db
				.query<{ name: string }, []>(
					`SELECT name FROM pragma_table_info('${table}')`,
				)
				.all()
				.map((row) => row.name);

		expect(
			db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'chunks_fts_%' ORDER BY name",
				)
				.all()
				.map((row) => row.name),
		).toEqual([
			"change_fields",
			"change_sections",
			"changes",
			"chunk_embed_failures",
			"chunk_embeddings",
			"chunks",
			"chunks_fts",
			"concept_embed_failures",
			"concept_embeddings",
			"concepts",
			"links",
			"meta",
			"note_names",
			"recall_log",
			"sections",
			"tags",
		]);
		expect(columns("concepts")).toEqual([
			"id",
			"path",
			"identifier",
			"dir",
			"title",
			"type",
			"description",
			"status",
			"stale_after",
			"trust",
			"frontmatter",
			"frontmatter_error",
			"content_hash",
			"byte_size",
			"mtime_ms",
			"indexed_at",
			"sources",
			"version",
			"archived",
			"next_section",
			"created_at",
			"updated_at",
		]);
		expect(columns("chunks")).toEqual([
			"id",
			"concept_id",
			"ordinal",
			"heading",
			"heading_path",
			"depth",
			"start_line",
			"end_line",
			"start_char",
			"end_char",
			"content",
			"content_hash",
			"token_estimate",
			"section_id",
		]);
		expect(columns("sections")).toEqual([
			"id",
			"concept_id",
			"sid",
			"position",
			"depth",
			"heading",
			"text",
			"version",
			"trust",
			"checked_by",
			"checked_at",
		]);
		expect(columns("changes")).toEqual([
			"id",
			"concept_id",
			"version",
			"at",
			"kind",
			"reason",
			"client",
			"project",
			"by_name",
			"undoes",
			"order_before",
		]);
		expect(columns("change_sections")).toEqual([
			"change_id",
			"sid",
			"op",
			"before_text",
			"after_text",
			"before_heading",
			"after_heading",
			"before_depth",
			"after_depth",
			"before_version",
			"after_version",
			"before_trust",
			"after_trust",
			"before_by",
			"before_at",
			"moved",
		]);
	});

	test("a store says it is one, so a file index is refused as a store and a store as an index", () => {
		const folder = freshHome();
		const storePath = join(folder, "store.db");
		const indexPath = join(folder, "lattice.db");
		openStore(storePath, { create: true }).close();
		openDatabase(indexPath, { create: true }).close();

		expect(() => openStore(indexPath)).toThrow(
			"This file is a file index, not a note store.",
		);
		expect(() => openDatabase(storePath)).toThrow(
			"This file is a note store, not a file index.",
		);
	});

	test("a store in another layout version is refused with what to do", () => {
		const path = join(freshHome(), "store.db");
		const db = openStore(path, { create: true });
		db.query("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
		db.close();

		expect(() => openStore(path)).toThrow(
			/note store's schema version 1 does not match the expected version 2.*restart the session/,
		);
	});
});
