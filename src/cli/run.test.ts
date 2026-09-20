import { describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./run.js";

const FIXTURE_BUNDLE = join(import.meta.dir, "..", "fixtures", "bundle");

/**
 * Every test drives the CLI through its single seam, `runCli`, with an
 * isolated LATTICE_HOME. Nothing here opens the database directly.
 */
function freshHome(): string {
	return mkdtempSync(join(tmpdir(), "lattice-test-"));
}

/**
 * The suite runs on the deterministic `hash` provider throughout: it needs no
 * model on disk and no network, and two of its widths are two vector spaces,
 * which is all the model-change tests need.
 */
function invoke(
	argv: string[],
	home: string = freshHome(),
	env: Record<string, string | undefined> = {},
) {
	return runCli({
		argv,
		env: { LATTICE_HOME: home, LATTICE_EMBED_PROVIDER: "hash", ...env },
	});
}

/** An initialised home whose docs directory holds the fixture OKF bundle. */
async function bundledHome(): Promise<string> {
	const home = freshHome();
	await invoke(["init"], home);
	cpSync(FIXTURE_BUNDLE, join(home, "docs"), { recursive: true });
	return home;
}

/** Rows from a read-only query, driven through the CLI like everything else. */
async function sql<Row>(home: string, query: string): Promise<Row[]> {
	const result = await invoke(["sql", query], home);
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout);
}

describe("runCli argument handling", () => {
	test("an unknown command exits non-zero with usage on stderr", async () => {
		const result = await invoke(["nonsense"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Unknown command: nonsense");
		expect(result.stderr).toContain("Usage: lattice <command>");
		expect(result.stdout).toBe("");
	});

	test("a missing required argument exits non-zero with usage on stderr", async () => {
		const result = await invoke(["search"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Missing required argument: <query>");
		expect(result.stderr).toContain("Usage: lattice search <query>");
		expect(result.stdout).toBe("");
	});

	test("no command at all prints usage on stderr and exits non-zero", async () => {
		const result = await invoke([]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Usage: lattice <command>");
	});
});

describe("lattice init", () => {
	test("creates the home directory, docs and database, and reports them", async () => {
		const home = freshHome();

		const result = await invoke(["init"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain(`Created ${join(home, "docs")}`);
		expect(result.stdout).toContain(`Created ${join(home, "lattice.db")}`);
		expect(existsSync(join(home, "docs"))).toBe(true);
		expect(existsSync(join(home, "lattice.db"))).toBe(true);
	});

	test("a second run exits zero and reports the existing artifacts", async () => {
		const home = freshHome();

		const first = await invoke(["init"], home);
		const second = await invoke(["init"], home);

		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(second.stderr).toBe("");
		expect(second.stdout).toContain(`Exists  ${join(home, "docs")}`);
		expect(second.stdout).toContain(`Exists  ${join(home, "lattice.db")}`);
		expect(second.stdout).not.toContain("Created");
	});
});

describe("lattice sql", () => {
	test("prints rows as JSON", async () => {
		const home = freshHome();
		await invoke(["init"], home);

		const result = await invoke(["sql", "SELECT 6 * 7 AS answer"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual([{ answer: 42 }]);
	});

	test("refuses to write", async () => {
		const home = freshHome();
		await invoke(["init"], home);

		const result = await invoke(
			["sql", "DELETE FROM meta WHERE key = 'schema_version'"],
			home,
		);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("read-only");
		expect(
			JSON.parse(
				(await invoke(["sql", "SELECT count(*) AS n FROM meta"], home)).stdout,
			),
		).toEqual([{ n: 1 }]);
	});
});

describe("lattice status", () => {
	test("reports an empty index and exits zero after init", async () => {
		const home = freshHome();
		await invoke(["init"], home);

		const result = await invoke(["status"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Concepts:   0");
		expect(result.stdout).toContain("Chunks:     0");
		expect(result.stdout).toContain("Embeddings: 0");
		expect(result.stdout).toContain("Links:      0");
		expect(result.stdout).toContain("Nothing indexed yet.");
	});

	test("exits non-zero when the index does not exist", async () => {
		const result = await invoke(["status"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("No Lattice index");
		expect(result.stderr).toContain("lattice init");
	});
});

describe("lattice sync", () => {
	test("indexes every non-reserved markdown file by its bundle-relative path", async () => {
		const home = await bundledHome();

		const result = await invoke(["sync"], home);

		expect(result.code).toBe(0);
		const paths = await sql<{ path: string }>(
			home,
			"SELECT path FROM concepts ORDER BY path",
		);
		expect(paths.map((row) => row.path)).toEqual([
			"concepts/orders.md",
			"concepts/users.md",
			"guides/chunking.md",
			"notes/broken.md",
			"notes/plain.md",
			"notes/unverified.md",
		]);
	});

	test("promotes the filter fields to columns and keeps the rest whole", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const [users] = await sql<{
			identifier: string;
			dir: string;
			type: string;
			title: string;
			description: string;
			status: string;
			stale_after: string;
			frontmatter: string;
		}>(
			home,
			"SELECT identifier, dir, type, title, description, status, stale_after, frontmatter" +
				" FROM concepts WHERE path = 'concepts/users.md'",
		);

		expect(users.identifier).toBe("concepts/users");
		expect(users.dir).toBe("concepts");
		expect(users.type).toBe("BigQuery Table");
		expect(users.title).toBe("Users table");
		expect(users.description).toBe("One row per registered account.");
		expect(users.status).toBe("stable");
		expect(users.stale_after).toBe("2027-01-01T00:00:00Z");

		// The remainder keeps the fields no column was promoted for, and drops
		// the promoted ones so there is one place to read each of them.
		const rest = JSON.parse(users.frontmatter);
		expect(rest.resource).toBe("bigquery://project/dataset/users");
		expect(rest.generated.by).toBe("human:ahormati");
		expect(rest).not.toHaveProperty("type");
		expect(rest).not.toHaveProperty("tags");
	});

	test("records tags and derives trust from the verification records", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		expect(
			await sql(
				home,
				"SELECT c.path, t.tag FROM tags t JOIN concepts c ON c.id = t.concept_id" +
					" ORDER BY c.path, t.tag",
			),
		).toEqual([
			{ path: "concepts/orders.md", tag: "data" },
			{ path: "concepts/users.md", tag: "core" },
			{ path: "concepts/users.md", tag: "data" },
			{ path: "guides/chunking.md", tag: "guide" },
		]);

		expect(
			await sql(home, "SELECT path, trust FROM concepts ORDER BY path"),
		).toEqual([
			{ path: "concepts/orders.md", trust: "machine-confirmed" },
			{ path: "concepts/users.md", trust: "human-reviewed" },
			{ path: "guides/chunking.md", trust: "unverified" },
			{ path: "notes/broken.md", trust: "unverified" },
			{ path: "notes/plain.md", trust: "unverified" },
			{ path: "notes/unverified.md", trust: "unverified" },
		]);
	});

	test("indexes a file with missing or invalid frontmatter with no type", async () => {
		const home = await bundledHome();

		const result = await invoke(["sync"], home);

		expect(result.code).toBe(0);
		expect(
			await sql(
				home,
				"SELECT path, type FROM concepts WHERE path LIKE 'notes/%' AND type IS NULL ORDER BY path",
			),
		).toEqual([
			{ path: "notes/broken.md", type: null },
			{ path: "notes/plain.md", type: null },
		]);
	});
});

/**
 * `guides/chunking.md` is laid out so its line numbers can be quoted here:
 * the heading of each section, and the fenced block, sit at known lines.
 */
interface ChunkRow {
	ordinal: number;
	heading: string | null;
	heading_path: string;
	start_line: number;
	end_line: number;
	start_char: number;
	end_char: number;
	content: string;
	token_estimate: number;
}

async function chunksOf(home: string, path: string): Promise<ChunkRow[]> {
	return sql<ChunkRow>(
		home,
		"SELECT ch.ordinal, ch.heading, ch.heading_path, ch.start_line, ch.end_line," +
			" ch.start_char, ch.end_char, ch.content, ch.token_estimate" +
			` FROM chunks ch JOIN concepts c ON c.id = ch.concept_id WHERE c.path = '${path}'` +
			" ORDER BY ch.ordinal",
	);
}

describe("chunking", () => {
	test("splits at headings, merging a section too short to stand alone", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const chunks = await chunksOf(home, "guides/chunking.md");

		expect(chunks.map((chunk) => chunk.heading)).toEqual([
			"Chunking guide",
			"Short",
			"Long section",
			"Long section",
			"Fenced code",
		]);
		// "## Short" holds one word, so it carries "## Merged target" with it.
		expect(chunks[1].content).toContain("Tiny.");
		expect(chunks[1].content).toContain(
			"This section is where the short section above ends up.",
		);
	});

	test("chunk offsets address the original file, frontmatter included", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const chunks = await chunksOf(home, "guides/chunking.md");

		// The fixture's first heading is on line 7, behind four lines of
		// frontmatter and its two delimiters; the section runs to the line before
		// "## Short" on line 14.
		expect(chunks[0].start_line).toBe(7);
		expect(chunks[0].end_line).toBe(13);
		expect(chunks[1].start_line).toBe(14);
		// The fenced section starts at "## Fenced code" and runs to the last line.
		expect(chunks[4].start_line).toBe(46);
		expect(chunks[4].end_line).toBe(82);

		const raw = readFileSync(
			join(home, "docs", "guides", "chunking.md"),
			"utf8",
		);
		expect(raw.slice(chunks[0].start_char, chunks[0].end_char).trim()).toBe(
			chunks[0].content,
		);
		expect(raw.split("\n")[chunks[0].start_line - 1]).toBe("# Chunking guide");
		expect(raw.split("\n")[chunks[4].start_line - 1]).toBe("## Fenced code");
	});

	test("splits an oversize section at paragraphs with an overlap", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const chunks = await chunksOf(home, "guides/chunking.md");
		const [first, second] = chunks.filter(
			(chunk) => chunk.heading === "Long section",
		);

		expect(first.token_estimate).toBeLessThanOrEqual(400);
		expect(second.token_estimate).toBeLessThanOrEqual(400);
		// Every paragraph survives the split, and the seam is overlapped rather
		// than cut clean: at least one paragraph appears in both pieces.
		const numbers = (chunk: ChunkRow) =>
			[...chunk.content.matchAll(/Paragraph number (\d+)\./g)].map(
				(match) => match[1],
			);
		expect(
			[...new Set([...numbers(first), ...numbers(second)])].sort(),
		).toEqual(["1", "10", "2", "3", "4", "5", "6", "7", "8", "9"]);
		expect(
			numbers(first).filter((n) => numbers(second).includes(n)).length,
		).toBeGreaterThan(0);
	});

	test("never splits a fenced code block, even over the cap", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const chunks = await chunksOf(home, "guides/chunking.md");
		const fenced = chunks.filter((chunk) => chunk.heading === "Fenced code");

		expect(fenced).toHaveLength(1);
		expect(fenced[0].token_estimate).toBeGreaterThan(400);
		// A `#` inside a fence is a comment, not a heading, so it starts nothing.
		expect(fenced[0].content).toContain(
			"# this line is not a heading, it is a comment inside the fence",
		);
		expect(fenced[0].content).toContain("sampleIdentifierNumber30");
	});
});

interface LinkRow {
	source: string;
	target: string | null;
	target_path: string;
	link_text: string | null;
	anchor: string | null;
	kind: string;
	context: string | null;
}

/** Every edge out of one document, read back through the CLI. */
async function linksFrom(home: string, path: string): Promise<LinkRow[]> {
	return sql<LinkRow>(
		home,
		"SELECT s.path AS source, t.path AS target, l.target_path, l.link_text," +
			" l.anchor, l.kind, l.context FROM links l" +
			" JOIN concepts s ON s.id = l.source_concept_id" +
			" LEFT JOIN concepts t ON t.id = l.target_concept_id" +
			` WHERE s.path = '${path}' ORDER BY l.id`,
	);
}

describe("authored links", () => {
	test("records body links inside the bundle, and nothing else", async () => {
		const home = await bundledHome();

		await invoke(["sync"], home);

		const links = await linksFrom(home, "concepts/users.md");
		// Three of the four links in the body point inside the bundle; the fourth
		// is an external URL, and the one in the fenced block is a code sample.
		expect(
			links.map((link) => [link.kind, link.target_path, link.link_text]),
		).toEqual([
			["markdown", "concepts/orders.md", "Orders table"],
			["markdown", "concepts/sessions.md", "Sessions table"],
			["markdown", "concepts/orders.md", "order columns"],
		]);
	});

	test("resolves a link that has a target and leaves the rest unresolved", async () => {
		const home = await bundledHome();

		await invoke(["sync"], home);

		const links = await linksFrom(home, "concepts/users.md");
		expect(links.map((link) => link.target)).toEqual([
			"concepts/orders.md",
			// `concepts/sessions.md` is not written yet, so the edge is kept and
			// left unresolved rather than dropped.
			null,
			"concepts/orders.md",
		]);
	});

	test("keeps the anchor and the sentence the link was written in", async () => {
		const home = await bundledHome();

		await invoke(["sync"], home);

		const [, , anchored] = await linksFrom(home, "concepts/users.md");
		expect(anchored.anchor).toBe("columns");
		expect(anchored.target).toBe("concepts/orders.md");
		expect(anchored.context).toBe(
			"`user_id` is the primary key, and the [order columns](orders.md#columns) are keyed by it too.",
		);
	});

	test("records a frontmatter citation as an edge of its own kind", async () => {
		const home = await bundledHome();

		await invoke(["sync"], home);

		const links = await linksFrom(home, "concepts/orders.md");
		// The citation of `users.md` and the body mention of it are both edges,
		// told apart by their kind; the cited URL is outside the bundle.
		expect(
			links.map((link) => [link.kind, link.target, link.link_text]),
		).toEqual([
			["source", "concepts/users.md", "Users table"],
			["markdown", "concepts/users.md", "Users table"],
		]);
	});

	test("attributes a link to the chunk it was written in", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const [rows] = await sql<{ heading: string }>(
			home,
			"SELECT ch.heading FROM links l JOIN chunks ch ON ch.id = l.source_chunk_id" +
				" JOIN concepts c ON c.id = l.source_concept_id" +
				" WHERE c.path = 'concepts/users.md' AND l.anchor = 'columns'",
		);

		expect(rows.heading).toBe("Columns");
	});

	test("writing the missing document resolves the link with no edit to the source", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);
		const sourceBefore = readFileSync(
			join(home, "docs", "concepts", "users.md"),
			"utf8",
		);

		writeFileSync(
			join(home, "docs", "concepts", "sessions.md"),
			"---\ntype: BigQuery Table\ntitle: Sessions table\n---\n\n# Sessions table\n\nOne row per session.\n",
		);
		await invoke(["sync"], home);

		expect((await linksFrom(home, "concepts/users.md"))[1].target).toBe(
			"concepts/sessions.md",
		);
		expect(
			readFileSync(join(home, "docs", "concepts", "users.md"), "utf8"),
		).toBe(sourceBefore);
	});

	test("moving a document re-aims the relative links it wrote", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		mkdirSync(join(home, "docs", "moved"));
		renameSync(
			join(home, "docs", "concepts", "users.md"),
			join(home, "docs", "moved", "users.md"),
		);
		await invoke(["sync"], home);

		// `[Orders table](orders.md)` is relative to the file that wrote it, so
		// from `moved/` it now names `moved/orders.md` — which nobody has
		// written. The old target must not stay resolved.
		expect(
			(await linksFrom(home, "moved/users.md")).map((link) => [
				link.target_path,
				link.target,
			]),
		).toEqual([
			["moved/orders.md", null],
			["moved/sessions.md", null],
			["moved/orders.md", null],
		]);
	});

	test("deleting a target leaves inbound links in place but unresolved", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		rmSync(join(home, "docs", "concepts", "orders.md"));
		await invoke(["sync"], home);

		const links = await linksFrom(home, "concepts/users.md");
		expect(links).toHaveLength(3);
		expect(links.map((link) => [link.target_path, link.target])).toEqual([
			["concepts/orders.md", null],
			["concepts/sessions.md", null],
			["concepts/orders.md", null],
		]);
	});
});

describe("lattice rels", () => {
	test("reports outlinks, backlinks, siblings and unresolved links", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["rels", "concepts/users"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		// Two body links out to the orders table, one citation and one body link
		// back from it, one sibling in `concepts/`, one link to a document that
		// has not been written.
		expect(result.stdout).toContain("Outgoing (2)");
		expect(result.stdout).toContain("Incoming (2)");
		expect(result.stdout).toContain("Siblings (1)");
		expect(result.stdout).toContain("Unresolved (1)");
		expect(result.stdout).toContain("concepts/orders.md");
		expect(result.stdout).toContain("concepts/sessions.md");
	});

	test("takes a path as readily as an identifier", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const byPath = await invoke(["rels", "concepts/users.md"], home);
		const byIdentifier = await invoke(["rels", "concepts/users"], home);

		expect(byPath.code).toBe(0);
		expect(byPath.stdout).toBe(byIdentifier.stdout);
	});

	test("--json emits the four relations machine-readably", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["rels", "concepts/users", "--json"], home);

		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.concept.path).toBe("concepts/users.md");
		expect(report.outlinks.map((link: { path: string }) => link.path)).toEqual([
			"concepts/orders.md",
			"concepts/orders.md",
		]);
		expect(
			report.backlinks.map((link: { path: string; kind: string }) => [
				link.path,
				link.kind,
			]),
		).toEqual([
			["concepts/orders.md", "source"],
			["concepts/orders.md", "markdown"],
		]);
		expect(
			report.siblings.map((sibling: { path: string }) => sibling.path),
		).toEqual(["concepts/orders.md"]);
		expect(
			report.unresolved.map(
				(link: { target_path: string }) => link.target_path,
			),
		).toEqual(["concepts/sessions.md"]);
	});

	test("exits non-zero for a concept that is not indexed", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["rels", "concepts/nowhere"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("concepts/nowhere");
		expect(result.stdout).toBe("");
	});
});

describe("incremental sync", () => {
	test("a second sync with no filesystem change does no work", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);
		const before = await sql(
			home,
			"SELECT id, path, content_hash, indexed_at FROM concepts ORDER BY id",
		);

		const second = await invoke(["sync"], home);

		expect(second.code).toBe(0);
		expect(second.stdout).toContain("Nothing to sync");
		expect(
			await sql(
				home,
				"SELECT id, path, content_hash, indexed_at FROM concepts ORDER BY id",
			),
		).toEqual(before);
	});

	test("changing one file re-indexes only that file", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);
		const untouchedBefore = await sql(
			home,
			"SELECT id, indexed_at FROM concepts WHERE path <> 'notes/unverified.md' ORDER BY id",
		);
		const [idBefore] = await sql<{ id: number }>(
			home,
			"SELECT id FROM concepts WHERE path = 'notes/unverified.md'",
		);

		writeFileSync(
			join(home, "docs", "notes", "unverified.md"),
			"---\ntype: Note\ntitle: Scratch note\n---\n\n# Scratch note\n\nRewritten.\n",
		);
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("0 new, 1 changed");
		expect(
			await sql(
				home,
				"SELECT id, indexed_at FROM concepts WHERE path <> 'notes/unverified.md' ORDER BY id",
			),
		).toEqual(untouchedBefore);
		expect((await chunksOf(home, "notes/unverified.md"))[0].content).toContain(
			"Rewritten.",
		);
		// The concept is the path, so an edit keeps the identity it had.
		const [idAfter] = await sql<{ id: number }>(
			home,
			"SELECT id FROM concepts WHERE path = 'notes/unverified.md'",
		);
		expect(idAfter.id).toBe(idBefore.id);
	});

	test("deleting a file removes its concept, chunks and tags", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);
		expect(await chunksOf(home, "concepts/users.md")).not.toHaveLength(0);

		rmSync(join(home, "docs", "concepts", "users.md"));
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("1 deleted");
		expect(
			await sql(
				home,
				"SELECT path FROM concepts WHERE path = 'concepts/users.md'",
			),
		).toEqual([]);
		expect(await chunksOf(home, "concepts/users.md")).toEqual([]);
		expect(
			await sql(
				home,
				"SELECT count(*) AS n FROM tags WHERE concept_id NOT IN (SELECT id FROM concepts)",
			),
		).toEqual([{ n: 0 }]);
	});

	test("renaming a file with unchanged content preserves its identity", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);
		const [before] = await sql<{ id: number; indexed_at: string }>(
			home,
			"SELECT id, indexed_at FROM concepts WHERE path = 'concepts/users.md'",
		);

		renameSync(
			join(home, "docs", "concepts", "users.md"),
			join(home, "docs", "concepts", "accounts.md"),
		);
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("1 renamed");
		expect(
			await sql(
				home,
				"SELECT id, identifier, indexed_at FROM concepts WHERE path = 'concepts/accounts.md'",
			),
		).toEqual([
			{
				id: before.id,
				identifier: "concepts/accounts",
				indexed_at: before.indexed_at,
			},
		]);
	});
});

describe("the sync lock", () => {
	test("refuses to start while another process holds the lock", async () => {
		const home = await bundledHome();
		writeFileSync(join(home, ".sync.lock"), `${process.pid}\n`);

		const result = await invoke(["sync"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Another sync is already running");
		expect(await sql(home, "SELECT count(*) AS n FROM concepts")).toEqual([
			{ n: 0 },
		]);
	});

	test("takes over a lock left behind by a dead process", async () => {
		const home = await bundledHome();
		const dead = Bun.spawnSync(["true"]);
		writeFileSync(join(home, ".sync.lock"), `${dead.pid}\n`);

		const result = await invoke(["sync"], home);

		expect(result.code).toBe(0);
		expect(existsSync(join(home, ".sync.lock"))).toBe(false);
		expect(await sql(home, "SELECT count(*) AS n FROM concepts")).toEqual([
			{ n: 6 },
		]);
	});
});

describe("lattice status against a bundle", () => {
	test("reports what a sync would do and names the broken frontmatter", async () => {
		const home = await bundledHome();

		const before = await invoke(["status"], home);

		expect(before.code).toBe(0);
		expect(before.stdout).toContain("New:     6");
		expect(before.stdout).toContain("Changed: 0");
		expect(before.stdout).toContain("Deleted: 0");
		expect(before.stdout).toContain("notes/broken.md");
		expect(before.stdout).toContain("notes/plain.md");
		expect(before.stdout).not.toContain("concepts/users.md");
	});

	test("reports an up-to-date bundle after a sync, then the next change", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const synced = await invoke(["status"], home);
		expect(synced.stdout).toContain("Concepts:   6");
		expect(synced.stdout).toContain("Up to date");

		writeFileSync(join(home, "docs", "notes", "added.md"), "# Added\n\nNew.\n");
		rmSync(join(home, "docs", "notes", "plain.md"));
		const changed = await invoke(["status"], home);

		expect(changed.stdout).toContain("New:     1");
		expect(changed.stdout).toContain("Deleted: 1");
	});
});

describe("interrupting a sync", () => {
	test("leaves a readable index the next sync completes", async () => {
		const home = await bundledHome();
		// Enough documents that the sync is still running when the signal lands;
		// if it has already finished, the assertions below still hold.
		for (let i = 0; i < 2000; i++) {
			writeFileSync(
				join(home, "docs", "notes", `bulk-${i}.md`),
				`---\ntype: Note\ntitle: Bulk ${i}\n---\n\n# Bulk ${i}\n\n${"Filler sentence. ".repeat(60)}\n`,
			);
		}

		const running = Bun.spawn(["bun", "run", "src/main.ts", "sync"], {
			env: {
				...process.env,
				LATTICE_HOME: home,
				LATTICE_EMBED_PROVIDER: "hash",
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		await Bun.sleep(200);
		running.kill("SIGINT");
		await running.exited;

		// The index is readable, the lock is gone, and the rest is just work to do.
		expect(existsSync(join(home, ".sync.lock"))).toBe(false);
		const result = await invoke(["sync"], home);
		expect(result.code).toBe(0);
		expect(await sql(home, "SELECT count(*) AS n FROM concepts")).toEqual([
			{ n: 2006 },
		]);
		expect(
			await sql(
				home,
				"SELECT count(*) AS n FROM concepts WHERE id NOT IN (SELECT concept_id FROM chunks)",
			),
		).toEqual([{ n: 0 }]);
	});
});

describe("the embedding phase", () => {
	test("sync gives every chunk a vector of the provider's dimension", async () => {
		const home = await bundledHome();

		const result = await invoke(["sync"], home);

		expect(result.code).toBe(0);
		expect(
			await sql(
				home,
				"SELECT count(*) AS n FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_embeddings)",
			),
		).toEqual([{ n: 0 }]);
		// 512 float32 values is 2048 bytes; the model rides with the vector.
		expect(
			await sql(
				home,
				"SELECT DISTINCT model, dim, length(vector) AS bytes FROM chunk_embeddings",
			),
		).toEqual([{ model: "hash-512", dim: 512, bytes: 2048 }]);
	});
});

describe("concept vectors", () => {
	test("are derived from the title, description and tags, not the body", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		// The fixture's two notes without frontmatter have no title, no
		// description and no tags, so there is nothing to embed for them.
		const embedded = await sql<{ path: string }>(
			home,
			"SELECT c.path FROM concepts c JOIN concept_embeddings e ON e.concept_id = c.id ORDER BY c.path",
		);
		expect(embedded.map((row) => row.path)).toEqual([
			"concepts/orders.md",
			"concepts/users.md",
			"guides/chunking.md",
			"notes/unverified.md",
		]);

		// Two concepts differing only in body text would share a vector; these
		// differ in title and tags, so they must not.
		const [pair] = await sql<{ same: number }>(
			home,
			"SELECT (SELECT vector FROM concept_embeddings e JOIN concepts c ON c.id = e.concept_id" +
				"   WHERE c.path = 'concepts/users.md')" +
				" = (SELECT vector FROM concept_embeddings e JOIN concepts c ON c.id = e.concept_id" +
				"   WHERE c.path = 'concepts/orders.md') AS same",
		);
		expect(pair.same).toBe(0);
	});
});

describe("provider failures", () => {
	/** The same home, with a fault injected into the deterministic provider. */
	function withFault(argv: string[], home: string, fault: string) {
		return runCli({
			argv,
			env: {
				LATTICE_HOME: home,
				LATTICE_EMBED_PROVIDER: "hash",
				LATTICE_EMBED_FAIL: fault,
			},
		});
	}

	test("a retryable failure leaves a backlog the next run clears", async () => {
		const home = await bundledHome();

		const synced = await withFault(["sync"], home, "retryable:Chunking");

		expect(synced.code).toBe(0);
		expect(synced.stdout).toContain("Failed:");
		const [pending] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_embeddings)",
		);
		expect(pending.n).toBeGreaterThan(0);
		expect(
			await sql(
				home,
				"SELECT retryable, attempts FROM chunk_embed_failures ORDER BY chunk_id LIMIT 1",
			),
		).toEqual([{ retryable: 1, attempts: 1 }]);

		// Nothing is re-read from disk; the backlog alone drives the work.
		const embedded = await invoke(["embed"], home);

		expect(embedded.code).toBe(0);
		expect(
			await sql(
				home,
				"SELECT count(*) AS n FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_embeddings)",
			),
		).toEqual([{ n: 0 }]);
		expect(
			await sql(home, "SELECT count(*) AS n FROM chunk_embed_failures"),
		).toEqual([{ n: 0 }]);
	});

	test("a permanent failure is retried only when asked", async () => {
		const home = await bundledHome();

		await withFault(["sync"], home, "permanent:Chunking");

		const [failed] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunk_embed_failures WHERE retryable = 0",
		);
		expect(failed.n).toBeGreaterThan(0);

		// The concept named in the fault fails permanently too, and both kinds
		// are reported together.
		const [permanent] = await sql<{ n: number }>(
			home,
			"SELECT (SELECT count(*) FROM chunk_embed_failures WHERE retryable = 0)" +
				" + (SELECT count(*) FROM concept_embed_failures WHERE retryable = 0) AS n",
		);

		// An ordinary run walks straight past them and says so.
		const again = await invoke(["embed"], home);
		expect(again.stdout).toContain("Embedded 0 chunks");
		expect(again.stdout).toContain(`Permanently failed: ${permanent.n}`);
		expect(
			await sql(
				home,
				"SELECT count(*) AS n FROM chunk_embed_failures WHERE retryable = 0",
			),
		).toEqual([{ n: failed.n }]);

		const retried = await invoke(["embed", "--retry-failed"], home);

		expect(retried.code).toBe(0);
		expect(retried.stdout).toContain(`Embedded ${failed.n} chunks`);
		expect(
			await sql(home, "SELECT count(*) AS n FROM chunk_embed_failures"),
		).toEqual([{ n: 0 }]);
	});

	test("re-chunking a document clears its stale failure records", async () => {
		const home = await bundledHome();
		await withFault(["sync"], home, "permanent:Chunking");
		expect(
			(
				await sql<{ n: number }>(
					home,
					"SELECT count(*) AS n FROM chunk_embed_failures",
				)
			)[0].n,
		).toBeGreaterThan(0);

		writeFileSync(
			join(home, "docs", "guides", "chunking.md"),
			"---\ntype: Guide\ntitle: Chunking\n---\n\n# Rewritten\n\nDifferent text entirely.\n",
		);
		await invoke(["sync"], home);

		expect(
			await sql(home, "SELECT count(*) AS n FROM chunk_embed_failures"),
		).toEqual([{ n: 0 }]);
	});
});

describe("lattice status and the embedding backlog", () => {
	test("names the model and dimensions and counts chunks awaiting vectors", async () => {
		const home = await bundledHome();

		await runCli({
			argv: ["sync"],
			env: {
				LATTICE_HOME: home,
				LATTICE_EMBED_PROVIDER: "hash",
				LATTICE_EMBED_FAIL: "retryable:Chunking",
			},
		});
		const waiting = await invoke(["status"], home);

		const [pending] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_embeddings)",
		);
		expect(waiting.code).toBe(0);
		expect(waiting.stdout).toContain("Model:  hash-512 (512 dimensions)");
		expect(waiting.stdout).toContain(`Awaiting vectors: ${pending.n}`);

		await invoke(["embed"], home);
		const done = await invoke(["status"], home);

		expect(done.stdout).toContain("Awaiting vectors: 0");
	});
});

describe("changing the embedding model", () => {
	/** The same bundle, indexed and embedded in the default (512) space. */
	async function embeddedHome(): Promise<string> {
		const home = await bundledHome();
		const result = await invoke(["sync"], home);
		expect(result.code).toBe(0);
		return home;
	}

	/** The same command, run in a narrower space — a different model. */
	function inNewSpace(argv: string[], home: string) {
		return invoke(argv, home, { LATTICE_EMBED_DIM: "256" });
	}

	test("sync under a changed model refuses and says what to do about it", async () => {
		const home = await embeddedHome();
		const [{ n: before }] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunk_embeddings",
		);

		const result = await inNewSpace(["sync"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("hash-512");
		expect(result.stderr).toContain("hash-256");
		expect(result.stderr).toContain(String(before));
		expect(result.stderr).toContain("LATTICE_EMBED_DIM");
		expect(result.stderr).toContain("lattice embed --reembed");

		// Nothing was written into the new space by the refused run.
		const [{ n: after }] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunk_embeddings WHERE dim = 256",
		);
		expect(after).toBe(0);
	});

	test("embed and search refuse the same change, rather than mixing spaces", async () => {
		const home = await embeddedHome();

		for (const argv of [["embed"], ["search", "users"]]) {
			const result = await inNewSpace(argv, home);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("hash-512");
			expect(result.stderr).toContain("hash-256");
			expect(result.stderr).toContain("lattice embed --reembed");
		}
	});

	test("--reembed rebuilds the index and drops the space it replaced", async () => {
		const home = await embeddedHome();

		const result = await inNewSpace(["embed", "--reembed"], home);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("hash-256");
		expect(
			await sql(
				home,
				"SELECT model, dim, count(*) AS n FROM chunk_embeddings GROUP BY model, dim",
			),
		).toEqual([{ model: "hash-256", dim: 256, n: expect.any(Number) }]);
		expect(
			await sql(home, "SELECT value FROM meta WHERE key = 'embedding_model'"),
		).toEqual([{ value: "hash-256" }]);

		// And the new space is now simply the index's own: nothing refuses.
		expect((await inNewSpace(["sync"], home)).code).toBe(0);
	});

	test("a permanent failure in the new space blocks the swap rather than losing vectors", async () => {
		const home = await embeddedHome();
		const [{ n: original }] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunk_embeddings WHERE model = 'hash-512'",
		);

		// One chunk can never be embedded in the new space. Finishing anyway
		// would delete a vector the index still has and cannot rebuild.
		const result = await invoke(["embed", "--reembed"], home, {
			LATTICE_EMBED_DIM: "256",
			LATTICE_EMBED_FAIL: "permanent:Users table",
		});

		expect(result.code).toBe(0);
		expect(
			await sql(home, "SELECT value FROM meta WHERE key = 'embedding_model'"),
		).toEqual([{ value: "hash-512" }]);
		expect(
			await sql<{ n: number }>(
				home,
				"SELECT count(*) AS n FROM chunk_embeddings WHERE model = 'hash-512'",
			),
		).toEqual([{ n: original }]);
		expect(result.stdout).toContain("--retry-failed");
	});

	test("an interrupted re-embed keeps the old vectors and resumes", async () => {
		const home = await embeddedHome();
		const [{ n: original }] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunk_embeddings WHERE model = 'hash-512'",
		);

		// One chunk of the fixture bundle cannot be embedded this run.
		const interrupted = await invoke(["embed", "--reembed"], home, {
			LATTICE_EMBED_DIM: "256",
			LATTICE_EMBED_FAIL: "retryable:Users table",
		});

		expect(interrupted.code).toBe(0);
		// The pointer has not moved, so the old vectors are still the ones a
		// search would read, and they are all still there.
		expect(
			await sql(home, "SELECT value FROM meta WHERE key = 'embedding_model'"),
		).toEqual([{ value: "hash-512" }]);
		expect(
			await sql<{ n: number }>(
				home,
				"SELECT count(*) AS n FROM chunk_embeddings WHERE model = 'hash-512'",
			),
		).toEqual([{ n: original }]);

		// Resuming completes it, and does not start over.
		const resumed = await inNewSpace(["embed", "--reembed"], home);

		expect(resumed.code).toBe(0);
		expect(
			await sql(home, "SELECT value FROM meta WHERE key = 'embedding_model'"),
		).toEqual([{ value: "hash-256" }]);
		expect(
			await sql<{ n: number }>(
				home,
				"SELECT count(*) AS n FROM chunk_embeddings WHERE model = 'hash-512'",
			),
		).toEqual([{ n: 0 }]);
	});
});

describe("the local model", () => {
	/** The real provider, with downloading forbidden and nothing cached. */
	function offline(argv: string[], home: string) {
		return invoke(argv, home, {
			LATTICE_EMBED_PROVIDER: undefined,
			HF_HUB_OFFLINE: "1",
		});
	}

	test("init still initialises when the model cannot be downloaded, and says what to place", async () => {
		const home = freshHome();

		const result = await offline(["init"], home);

		expect(result.code).toBe(0);
		expect(existsSync(join(home, "lattice.db"))).toBe(true);
		expect(result.stdout).toContain("Embeddings are not ready yet");
		expect(result.stdout).toContain(join(home, "models"));
		expect(result.stdout).toContain("nomic-ai/nomic-embed-text-v1.5");
	});

	test("sync says what model is missing rather than failing obscurely", async () => {
		const home = await bundledHome();

		const result = await offline(["sync"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(join(home, "models"));
		expect(result.stderr).toContain("LATTICE_OFFLINE");
	});

	test("status still reports the index when the model is not there", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await offline(["status"], home);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Chunks:     11");
		expect(result.stdout).toContain("Embeddings: 11");
		expect(result.stdout).toContain("Embeddings are not ready yet");
	});

	test("init reports progress while it works", async () => {
		const home = freshHome();
		// A model directory that is present is not downloaded — the reported
		// line is the one progress channel either way.
		const models = join(home, "models", "nomic-ai", "nomic-embed-text-v1.5");
		mkdirSync(join(models, "onnx"), { recursive: true });
		for (const file of [
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
		]) {
			writeFileSync(join(models, file), "{}");
		}
		writeFileSync(join(models, "onnx", "model_quantized.onnx"), "");

		const result = await invoke(["init"], home, {
			LATTICE_EMBED_PROVIDER: undefined,
			LATTICE_OFFLINE: "1",
		});

		expect(result.code).toBe(0);
		expect(result.progress.join("\n")).toContain(
			`Model nomic-embed-text-v1.5 is already in ${join(home, "models")}`,
		);
	});
});
