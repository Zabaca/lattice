import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runCli } from "../cli/run.js";
import { selectProvider } from "../embed/provider.js";
import { importNotes } from "./import.js";
import {
	BUNDLE,
	cli,
	freshHome,
	HASH_ENV,
	LIBRARY,
	note,
	writeFileIndex,
	writeFiles,
	writeLibrary,
} from "./testing.js";

/** Everything under a folder as path to text, to prove an import wrote nothing there. */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else {
				out[path] = readFileSync(path, "utf8");
			}
		}
	};
	if (existsSync(root)) {
		walk(root);
	}
	return out;
}

async function importJson(home: string, argv: string[] = [], env = {}) {
	const result = await cli(home, ["import", "--json", ...argv], env);
	return {
		...result,
		report: result.stdout === "" ? undefined : JSON.parse(result.stdout),
	};
}

async function rows<Row>(home: string, query: string): Promise<Row[]> {
	const result = await cli(home, ["sql", query]);
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout);
}

function bundleHome(): string {
	const home = freshHome();
	writeFiles(home, "docs", BUNDLE);
	return home;
}

describe("lattice import: today's bundle", () => {
	test("makes a note of every file and proves the text and the fields came through whole", async () => {
		const home = bundleHome();

		const { code, report } = await importJson(home);

		expect(code).toBe(0);
		expect(report.clean).toBe(true);
		expect(report.bundle).toMatchObject({
			notes: 4,
			byType: { Research: 3, Topic: 1 },
			sections: 10,
			roundTrip: { checked: 4, exact: 4, mismatches: [] },
			fields: { checked: 4, exact: 4, mismatches: [] },
			links: { total: 4, source: 1, wikilink: 2, markdown: 1, unresolved: 1 },
		});
		expect(report.bundle.passages).toBe(report.bundle.vectors);
		expect(report.library).toBeUndefined();
	});

	test("names each note by its path and records an import change for it", async () => {
		const home = bundleHome();
		await importJson(home);

		const notes = await rows<{
			identifier: string;
			type: string;
			version: number;
		}>(
			home,
			"SELECT identifier, type, version FROM concepts ORDER BY identifier",
		);
		const changes = await rows<{
			kind: string;
			version: number;
			client: string;
		}>(home, "SELECT kind, version, client FROM changes");

		expect(notes).toEqual([
			{ identifier: "research/exa-limits", type: "Research", version: 1 },
			{ identifier: "research/jev-reranker", type: "Research", version: 1 },
			{ identifier: "research/long-note", type: "Research", version: 1 },
			{ identifier: "topic/jev", type: "Topic", version: 1 },
		]);
		expect(changes).toHaveLength(4);
		expect(
			changes.every(
				(c) =>
					c.kind === "import" &&
					c.version === 1 &&
					c.client === "lattice import",
			),
		).toBe(true);
	});

	test("keeps a note's other frontmatter as written, and its sources", async () => {
		const home = bundleHome();
		await importJson(home);

		const [row] = await rows<{ frontmatter: string; sources: string }>(
			home,
			"SELECT frontmatter, sources FROM concepts WHERE identifier = 'topic/jev'",
		);
		const [cited] = await rows<{ sources: string }>(
			home,
			"SELECT sources FROM concepts WHERE identifier = 'research/jev-reranker'",
		);

		expect(JSON.parse(row.frontmatter)).toEqual({
			generated: {
				by: "agent:claude-code/research",
				at: "2026-09-21T13:29:37Z",
			},
		});
		expect(JSON.parse(cited.sources)).toEqual([
			"../topic/jev.md",
			"https://example.com/jev",
		]);
	});

	test("every section starts unchecked", async () => {
		const home = bundleHome();
		await importJson(home);

		const trust = await rows<{ trust: string; n: number }>(
			home,
			"SELECT trust, count(*) AS n FROM sections GROUP BY trust",
		);

		expect(trust).toEqual([{ trust: "unverified", n: 10 }]);
	});

	test("writes nothing to the bundle, and builds the store beside it", async () => {
		const home = bundleHome();
		const before = snapshot(join(home, "docs"));

		await importJson(home);

		expect(snapshot(join(home, "docs"))).toEqual(before);
		expect(existsSync(join(home, "store.db"))).toBe(true);
		expect(readdirSync(home).sort()).toEqual(["docs", "store.db"]);
	});

	test("a file whose frontmatter cannot be read stops the import: its fields would be lost", async () => {
		const home = freshHome();
		writeFiles(home, "docs", {
			"note/broken.md":
				'---\ntype: Note\ntitle: "unterminated\ntags: [\n---\n\n# Broken\n\nBody.\n',
		});

		const { code, report } = await importJson(home);
		const plain = await cli(home, ["import"]);

		expect(code).toBe(1);
		expect(report.clean).toBe(false);
		expect(report.unreadable).toEqual(["note/broken"]);
		expect(report.problems).toEqual([
			{
				name: "note/broken",
				problem: expect.stringContaining("frontmatter is not valid YAML"),
			},
		]);
		expect(plain.stdout).toContain(
			"frontmatter lost (fix the YAML and import again): note/broken",
		);
		expect(plain.stdout).toContain("SOMETHING DIFFERS");
	});

	test("a file with no type, no frontmatter or an empty one loses nothing, so it is imported as a plain note", async () => {
		const home = freshHome();
		writeFiles(home, "docs", {
			"note/untyped.md": "---\ntitle: Untyped\n---\n\n# Untyped\n\nBody.\n",
			"note/bare.md": "# Bare\n\nNo frontmatter at all.\n",
			"note/empty.md": "---\n---\n\n# Empty\n\nBody.\n",
		});

		const { code, report } = await importJson(home);

		expect(code).toBe(0);
		expect(report.unreadable).toEqual([]);
		expect(report.problems.map((p: { name: string }) => p.name).sort()).toEqual(
			["note/bare", "note/empty", "note/untyped"],
		);
		expect(report.bundle.fields).toMatchObject({ checked: 3, exact: 3 });
	});

	test("the plain report says what was checked and ends with a verdict", async () => {
		const home = bundleHome();

		const result = await cli(home, ["import"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"Bundle: 4 notes (3 Research, 1 Topic), 10 sections",
		);
		expect(result.stdout).toContain("text joined back equals the file: 4 of 4");
		expect(result.stdout).toContain("fields equal the frontmatter: 4 of 4");
		expect(result.stdout).toEndWith("Nothing differs.\n");
	});
});

describe("an import whose verification fails", () => {
	const provider = () => selectProvider(HASH_ENV);

	async function tampered(damage: (db: Database) => void) {
		const home = bundleHome();
		const report = await importNotes({
			storePath: join(home, "store.db"),
			docs: join(home, "docs"),
			provider: provider(),
			report: () => undefined,
			beforeVerify: damage,
		});
		return { home, report };
	}

	test("text that does not join back to its file stops the store taking the live path", async () => {
		const { home, report } = await tampered((db) =>
			db
				.query(
					"UPDATE sections SET text = text || 'x' WHERE sid = 's2' AND concept_id = (SELECT id FROM concepts WHERE identifier = 'topic/jev')",
				)
				.run(),
		);

		expect(report.clean).toBe(false);
		expect(report.bundle?.roundTrip.exact).toBe(3);
		expect(report.bundle?.roundTrip.mismatches).toHaveLength(1);
		expect(existsSync(join(home, "store.db"))).toBe(false);
		expect(existsSync(join(home, "store.db.failed"))).toBe(true);
		expect(report.failedAt).toBe(join(home, "store.db.failed"));
		expect(readdirSync(home).sort()).toEqual(["docs", "store.db.failed"]);
	});

	test("fields that differ from the frontmatter do the same", async () => {
		const { home, report } = await tampered((db) =>
			db.query("UPDATE concepts SET title = 'Tampered' WHERE id = 1").run(),
		);

		expect(report.clean).toBe(false);
		expect(report.bundle?.fields.exact).toBe(3);
		expect(report.bundle?.fields.mismatches[0]).toContain(
			'title is "Tampered"',
		);
		expect(existsSync(join(home, "store.db"))).toBe(false);
	});

	test("through the command: exit 1, the verdict, no store, and the kept copy named", async () => {
		const home = bundleHome();
		writeFiles(home, "docs", {
			"note/broken.md": '---\ntitle: "x\ntags: [\n---\n\nBody.\n',
		});

		const result = await cli(home, ["import"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("SOMETHING DIFFERS: do not cut over.");
		expect(result.stdout).toContain(
			`The store was not installed. It is kept at ${join(home, "store.db.failed")} for inspection.`,
		);
		expect(existsSync(join(home, "store.db"))).toBe(false);
	});

	test("a rerun after fixing the file is not refused, and replaces the kept copy", async () => {
		const home = bundleHome();
		writeFiles(home, "docs", {
			"note/broken.md": '---\ntitle: "x\ntags: [\n---\n\nBody.\n',
		});
		expect((await cli(home, ["import"])).code).toBe(1);

		writeFiles(home, "docs", {
			"note/broken.md": "---\ntype: Note\ntitle: Fixed\n---\n\nBody.\n",
		});
		const again = await cli(home, ["import"]);

		expect(again.code).toBe(0);
		expect(existsSync(join(home, "store.db"))).toBe(true);
	});
});

describe("two imports at once", () => {
	test("one installs its store, the other is refused and leaves nothing behind", async () => {
		const home = bundleHome();
		const run = () =>
			importNotes({
				storePath: join(home, "store.db"),
				docs: join(home, "docs"),
				provider: selectProvider(HASH_ENV),
				report: () => undefined,
			});

		const settled = await Promise.allSettled([run(), run()]);

		const failures = settled.filter((s) => s.status === "rejected");
		expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
		expect(failures).toHaveLength(1);
		expect(String((failures[0] as PromiseRejectedResult).reason)).toContain(
			"A store appeared at",
		);
		expect(readdirSync(home).sort()).toEqual(["docs", "store.db"]);
		const count = await rows<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM concepts",
		);
		expect(count).toEqual([{ n: 4 }]);
	});
});

describe("lattice import: refusals", () => {
	test("refuses to import over a store that exists, and leaves it alone", async () => {
		const home = bundleHome();
		await importJson(home);
		const before = statSync(join(home, "store.db")).mtimeMs;

		const again = await cli(home, ["import"]);

		expect(again.code).toBe(1);
		expect(again.stderr).toContain("A store already exists at");
		expect(again.stderr).toContain("move it aside first");
		expect(statSync(join(home, "store.db")).mtimeMs).toBe(before);
	});

	test("with nothing to import it says where it looked and what to pass", async () => {
		const home = freshHome();

		const result = await cli(home, ["import"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Nothing to import");
		expect(result.stderr).toContain("--docs <dir>");
	});

	test("two sources that would make the same note stop the import before anything is built", async () => {
		const home = bundleHome();
		writeLibrary(home);
		writeFiles(home, "docs", {
			"v1/jev/gone.md": note(["type: Note", "title: Clash"], "# Clash\n"),
		});

		const result = await cli(home, ["import"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toBe(
			"Two sources would both make the note v1/jev/gone.",
		);
		expect(readdirSync(home).sort()).toEqual(["archive", "docs"]);
	});
});

describe("lattice import: Lattice 1's library", () => {
	test("makes a note of every file under docs and lost, named v1/ plus its path, index.md included", async () => {
		const home = bundleHome();
		writeLibrary(home);

		const { code, report } = await importJson(home);
		const names = await rows<{ identifier: string }>(
			home,
			"SELECT identifier FROM concepts WHERE identifier LIKE 'v1/%' ORDER BY identifier",
		);

		expect(code).toBe(0);
		expect(names.map((n) => n.identifier)).toEqual([
			"v1/README",
			"v1/exa/limits",
			"v1/jev/gone",
			"v1/jev/reranking",
			"v1/problems/index",
		]);
		expect(report.library).toMatchObject({
			notes: 5,
			byType: { "Lattice 1": 5 },
			fullText: 4,
			stubs: 1,
			roundTrip: { checked: 5, exact: 5 },
			fields: { checked: 5, exact: 5 },
		});
		expect(report.problems).toEqual([]);
	});

	test("gives them the type Lattice 1, marks them old with a past stale-after date, and keeps what they said", async () => {
		const home = bundleHome();
		writeLibrary(home);
		await importJson(home);

		const [row] = await rows<{
			type: string;
			status: string;
			stale_after: string;
			frontmatter: string;
		}>(
			home,
			"SELECT type, status, stale_after, frontmatter FROM concepts WHERE identifier = 'v1/jev/reranking'",
		);
		const tags = await rows<{ tag: string }>(
			home,
			"SELECT tag FROM tags t JOIN concepts c ON c.id = t.concept_id WHERE c.identifier = 'v1/jev/reranking' ORDER BY t.rowid",
		);
		const [stub] = await rows<{ stale_after: string }>(
			home,
			"SELECT stale_after FROM concepts WHERE identifier = 'v1/jev/gone'",
		);
		const stubTags = await rows<{ tag: string }>(
			home,
			"SELECT tag FROM tags t JOIN concepts c ON c.id = t.concept_id WHERE c.identifier = 'v1/jev/gone' ORDER BY t.rowid",
		);

		expect(row).toMatchObject({
			type: "Lattice 1",
			status: "archived",
			stale_after: "2026-02-22",
		});
		expect(JSON.parse(row.frontmatter)).toEqual({
			created: "2026-01-05T00:00:00Z",
			original_path: "/old/jev/reranking.md",
		});
		expect(tags.map((t) => t.tag)).toEqual(["jev", "reranker", "old"]);
		expect(stub.stale_after).toBe("2026-08-05");
		expect(stubTags.map((t) => t.tag)).toEqual(["old", "full-text-lost"]);
	});

	test("a note's lead paragraph above its first heading is a section of its own", async () => {
		const home = bundleHome();
		writeLibrary(home);
		await importJson(home);

		const sections = await rows<{
			sid: string;
			depth: number;
			heading: string | null;
		}>(
			home,
			"SELECT s.sid, s.depth, s.heading FROM sections s JOIN concepts c ON c.id = s.concept_id WHERE c.identifier = 'v1/jev/reranking' ORDER BY s.position",
		);

		expect(sections).toEqual([
			{ sid: "s1", depth: 0, heading: null },
			{ sid: "s2", depth: 2, heading: "Reranking" },
		]);
	});

	test("their relative links connect among themselves, and a dead one stays dead", async () => {
		const home = bundleHome();
		writeLibrary(home);
		await importJson(home);

		const links = await rows<{ target_path: string; resolved: number }>(
			home,
			`SELECT l.target_path, l.target_concept_id IS NOT NULL AS resolved
			FROM links l JOIN concepts c ON c.id = l.source_concept_id
			WHERE c.identifier = 'v1/jev/reranking' ORDER BY l.id`,
		);

		expect(links).toEqual([
			{ target_path: "v1/exa/limits.md", resolved: 1 },
			{ target_path: "v1/jev/missing.md", resolved: 0 },
		]);
	});

	test("the library's two generated title lists are kept but archived; the rest are not", async () => {
		const home = bundleHome();
		writeLibrary(home);

		const { report } = await importJson(home);
		const archived = await rows<{ identifier: string }>(
			home,
			"SELECT identifier FROM concepts WHERE archived = 1",
		);

		expect(archived).toEqual([{ identifier: "v1/README" }]);
		expect(report.library.archived).toBe(1);
	});

	test("a type a library file did have is kept as a field, not thrown away", async () => {
		const home = freshHome();
		writeFiles(home, "archive/v1/docs", {
			"x/typed.md": note(["title: Typed", "type: Guide"], "# Typed\n\nBody.\n"),
		});

		const { code, report } = await importJson(home);
		const [row] = await rows<{ type: string; frontmatter: string }>(
			home,
			"SELECT type, frontmatter FROM concepts WHERE identifier = 'v1/x/typed'",
		);

		expect(code).toBe(0);
		expect(row.type).toBe("Lattice 1");
		expect(JSON.parse(row.frontmatter)).toEqual({ v1_type: "Guide" });
		expect(report.library.fields.exact).toBe(1);
	});

	test("a file with no title is given one from its first heading, and the report counts it", async () => {
		const home = freshHome();
		writeFiles(home, "archive/v1/docs", {
			"x/untitled.md": "# First heading\n\nBody.\n",
		});

		const { report } = await importJson(home);
		const [row] = await rows<{ title: string; status: string | null }>(
			home,
			"SELECT title, status FROM concepts WHERE identifier = 'v1/x/untitled'",
		);

		// A status the file lacked stays empty; "archived" would read as the flag.
		expect(row).toEqual({ title: "First heading", status: null });
		expect(report.additions).toEqual({
			title: 1,
			type: 1,
			stale_after: 1,
			"tag old": 1,
		});
	});

	test("--no-library and --no-docs each leave their source out", async () => {
		const home = bundleHome();
		writeLibrary(home);

		const docsOnly = await importJson(home, ["--no-library"]);
		expect(docsOnly.report.library).toBeUndefined();
		expect(docsOnly.report.bundle.notes).toBe(4);

		const other = bundleHome();
		writeLibrary(other);
		const libraryOnly = await importJson(other, ["--no-docs"]);
		expect(libraryOnly.report.bundle).toBeUndefined();
		expect(libraryOnly.report.library.notes).toBe(5);
	});

	test("--docs and --library name sources anywhere, not only in the home", async () => {
		const sources = freshHome();
		writeFiles(sources, "bundle", BUNDLE);
		writeFiles(sources, "lib/docs", LIBRARY.docs);
		const home = freshHome();

		const { code, report } = await importJson(home, [
			"--docs",
			join(sources, "bundle"),
			"--library",
			join(sources, "lib"),
		]);

		expect(code).toBe(0);
		expect(report.bundle.notes).toBe(4);
		expect(report.library.notes).toBe(4);
	});
});

describe("lattice import: Lattice 2's file index", () => {
	async function indexedHome(library: boolean): Promise<string> {
		const home = bundleHome();
		if (library) {
			writeLibrary(home);
		}
		writeFileIndex(home);
		return home;
	}

	test("copies every vector from the index it can, and embeds nothing for the bundle", async () => {
		const home = await indexedHome(false);

		const { code, report } = await importJson(home);

		expect(code).toBe(0);
		expect(report.copied).toEqual({
			passages: report.bundle.passages,
			notes: 4,
		});
		expect(report.embedding).toEqual({ passages: 0, notes: 0, failed: 0 });
	});

	test("an index in another vector space is not copied; everything is embedded", async () => {
		const home = await indexedHome(false);

		const { code, report } = await importJson(home, [], {
			LATTICE_EMBED_DIM: "64",
		});

		expect(code).toBe(0);
		expect(report.copied).toEqual({ passages: 0, notes: 0 });
		expect(report.embedding.passages).toBe(report.bundle.passages);
		expect(report.parity).toBeUndefined();
	});

	test("the top five notes for each title, description and question match today's index", async () => {
		const home = await indexedHome(false);
		writeFileSync(
			join(home, "questions.txt"),
			"reciprocal rank fusion\nwhat can Exa not do\n",
		);

		const { code, report } = await importJson(home, [
			"--questions",
			join(home, "questions.txt"),
		]);

		expect(code).toBe(0);
		// 4 titles, 3 descriptions (the long note has none), 2 questions.
		expect(report.parity).toMatchObject({
			queries: 9,
			matched: 9,
			differing: [],
		});
		expect(report.parityInStore).toBeUndefined();
	});

	test("with the library in, parity is measured on the bundle alone, and old notes never outrank their own newer ones", async () => {
		const home = await indexedHome(true);

		const { code, report } = await importJson(home);

		expect(code).toBe(0);
		expect(report.parity).toMatchObject({
			queries: 7,
			matched: 7,
			firstMatched: 7,
			differing: [],
		});
		// In the full store near-ties may reorder, but the best note may not move.
		expect(report.parityInStore).toMatchObject({
			queries: 7,
			firstMatched: 7,
		});
		expect(report.newerFirst).toEqual({ checked: 4, passed: 4, failed: [] });
		expect(report.library.vectors).toBe(report.library.passages);
		expect(report.embedding.passages).toBe(report.library.passages);
	});

	test("the plain report carries both checks", async () => {
		const home = await indexedHome(true);

		const result = await cli(home, ["import"]);

		expect(result.stdout).toContain(
			"Search against today's index (bundle notes only): 7 of 7 queries give the same top five",
		);
		expect(result.stdout).toContain(
			"Newer first: 4 of 4 bundle titles find their own note above every old note",
		);
		expect(result.stdout).toContain("Lattice 1: 5 notes (5 Lattice 1)");
	});
});

describe("lattice import: embedding trouble", () => {
	test("a passage that cannot be embedded does not stop the import; the report counts it", async () => {
		const home = bundleHome();

		const { code, report } = await importJson(home, [], {
			LATTICE_EMBED_FAIL: "permanent:exact quoted phrase",
		});

		expect(code).toBe(0);
		expect(report.embedding.failed).toBe(1);
		expect(report.bundle.vectors).toBe(report.bundle.passages - 1);
	});
});

describe("the store from the command line", () => {
	test("sql reads the store and refuses to write it", async () => {
		const home = bundleHome();
		await importJson(home);

		const read = await cli(home, ["sql", "SELECT count(*) AS n FROM sections"]);
		const write = await cli(home, ["sql", "DELETE FROM sections"]);

		expect(JSON.parse(read.stdout)).toEqual([{ n: 10 }]);
		expect(write.code).toBe(1);
		expect(write.stderr).toContain(
			"lattice sql is read-only and refused this statement",
		);
		expect(
			JSON.parse(
				(await cli(home, ["sql", "SELECT count(*) AS n FROM sections"])).stdout,
			),
		).toEqual([{ n: 10 }]);
	});

	test("with no store every command says what to run", async () => {
		const home = freshHome();
		for (const argv of [
			["sql", "SELECT 1"],
			["search", "anything"],
			["rels", "topic/jev"],
			["embed"],
			["history"],
			["backup"],
		]) {
			const result = await cli(home, argv);

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("No note store at");
			expect(result.stderr).toContain("lattice init");
			expect(result.stderr).toContain("lattice import");
		}
	});

	test("a command that no longer exists is refused as unknown", async () => {
		const result = await cli(freshHome(), ["sync"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unknown command: sync");
	});

	test("search asks the store, with the same engine", async () => {
		const home = bundleHome();
		await importJson(home);

		const result = await cli(home, [
			"search",
			"reciprocal rank fusion",
			"--json",
		]);

		const answer = JSON.parse(result.stdout);
		expect(answer.degraded).toBe(false);
		expect(answer.hits[0].identifier).toBe("research/jev-reranker");
	});

	test("rels shows a note's links", async () => {
		const home = bundleHome();
		await importJson(home);

		const result = await cli(home, ["rels", "topic/jev", "--json"]);

		const rels = JSON.parse(result.stdout);
		expect(rels.outlinks.map((l: { path: string }) => l.path)).toEqual([
			"research/jev-reranker.md",
		]);
		expect(
			rels.unresolved.map((l: { target_path: string }) => l.target_path),
		).toEqual(["research/jev-costs.md"]);
	});

	test("rels says so for a note that is not there", async () => {
		const home = bundleHome();
		await importJson(home);

		const result = await cli(home, ["rels", "topic/nowhere"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No note matches topic/nowhere");
	});

	test("status gives the counts and says whether search is healthy", async () => {
		const home = bundleHome();
		await importJson(home);

		const result = await cli(home, ["status"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"Notes:     4 (3 Research, 1 Topic); 0 old, 0 archived",
		);
		expect(result.stdout).toContain("Sections:  10; 10 unchecked");
		expect(result.stdout).toContain("Search:    full");
	});

	test("status says why search is degraded", async () => {
		const home = bundleHome();
		await importJson(home);

		const result = await runCli({
			argv: ["status"],
			env: {
				...HASH_ENV,
				LATTICE_EMBED_PROVIDER: "hash",
				LATTICE_EMBED_DIM: "64",
				LATTICE_HOME: home,
			},
		});

		expect(result.stdout).toContain(
			"degraded: the store is embedded with hash-512 (512) but this server would use hash-64 (64)",
		);
	});
});

describe("lattice init and import together", () => {
	test("init makes an empty store that import then replaces", async () => {
		const home = bundleHome();

		const init = await cli(home, ["init"]);
		const empty = await cli(home, ["status"]);
		const { code, report } = await importJson(home);

		expect(init.code).toBe(0);
		expect(init.stdout).toContain(`Created ${join(home, "store.db")}`);
		expect(empty.stdout).toContain("Notes:     0");
		expect(code).toBe(0);
		expect(report.bundle.notes).toBe(4);
		expect((await cli(home, ["status"])).stdout).toContain("Notes:     4");
	});

	test("a second init leaves the store alone", async () => {
		const home = freshHome();
		await cli(home, ["init"]);

		const again = await cli(home, ["init"]);

		expect(again.code).toBe(0);
		expect(again.stdout).toContain(`Exists  ${join(home, "store.db")}`);
		expect(again.stdout).not.toContain("Created");
	});

	test("import does not replace a store that holds notes", async () => {
		const home = bundleHome();
		await importJson(home);

		const again = await cli(home, ["import"]);

		expect(again.code).toBe(1);
		expect(again.stderr).toContain("A store already exists");
		expect((await cli(home, ["status"])).stdout).toContain("Notes:     4");
	});
});
