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
const FIXTURE_HYBRID = join(import.meta.dir, "..", "fixtures", "hybrid");

/**
 * Every test drives the CLI through its single seam, `runCli`, with an
 * isolated LATTICE_HOME. Nothing here opens the database directly.
 */
function freshHome(): string {
	return mkdtempSync(join(tmpdir(), "lattice-test-"));
}

/**
 * The suite runs on the deterministic `hash` provider unless a test says
 * otherwise: it needs no model on disk and no network, and two of its widths
 * are two vector spaces, which is all the model-change tests need.
 */
function invoke(
	argv: string[],
	home: string = freshHome(),
	env: Record<string, string | undefined> = {},
) {
	return runCli({
		argv,
		env: { LATTICE_EMBED_PROVIDER: "hash", ...env, LATTICE_HOME: home },
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
			"bigquery-table/orders.md",
			"bigquery-table/users.md",
			"gauge/body-match.md",
			"gauge/fresh-widget.md",
			"gauge/heading-match.md",
			"gauge/stale-widget.md",
			"gauge/title-match.md",
			"guide/chunking.md",
			"note/broken.md",
			"note/plain.md",
			"note/unverified.md",
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
				" FROM concepts WHERE path = 'bigquery-table/users.md'",
		);

		expect(users.identifier).toBe("bigquery-table/users");
		expect(users.dir).toBe("bigquery-table");
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
			{ path: "bigquery-table/orders.md", tag: "data" },
			{ path: "bigquery-table/users.md", tag: "core" },
			{ path: "bigquery-table/users.md", tag: "data" },
			{ path: "gauge/body-match.md", tag: "rank" },
			{ path: "gauge/fresh-widget.md", tag: "rank" },
			{ path: "gauge/heading-match.md", tag: "rank" },
			{ path: "gauge/stale-widget.md", tag: "rank" },
			{ path: "gauge/title-match.md", tag: "rank" },
			{ path: "guide/chunking.md", tag: "guide" },
		]);

		expect(
			await sql(home, "SELECT path, trust FROM concepts ORDER BY path"),
		).toEqual([
			{ path: "bigquery-table/orders.md", trust: "machine-confirmed" },
			{ path: "bigquery-table/users.md", trust: "human-reviewed" },
			{ path: "gauge/body-match.md", trust: "unverified" },
			{ path: "gauge/fresh-widget.md", trust: "unverified" },
			{ path: "gauge/heading-match.md", trust: "unverified" },
			{ path: "gauge/stale-widget.md", trust: "unverified" },
			{ path: "gauge/title-match.md", trust: "unverified" },
			{ path: "guide/chunking.md", trust: "unverified" },
			{ path: "note/broken.md", trust: "unverified" },
			{ path: "note/plain.md", trust: "unverified" },
			{ path: "note/unverified.md", trust: "unverified" },
		]);
	});

	test("indexes a file with missing or invalid frontmatter with no type", async () => {
		const home = await bundledHome();

		const result = await invoke(["sync"], home);

		expect(result.code).toBe(0);
		expect(
			await sql(
				home,
				"SELECT path, type FROM concepts WHERE path LIKE 'note/%' AND type IS NULL ORDER BY path",
			),
		).toEqual([
			{ path: "note/broken.md", type: null },
			{ path: "note/plain.md", type: null },
		]);
	});
});

/**
 * `guide/chunking.md` is laid out so its line numbers can be quoted here:
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

		const chunks = await chunksOf(home, "guide/chunking.md");

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

		const chunks = await chunksOf(home, "guide/chunking.md");

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
			join(home, "docs", "guide", "chunking.md"),
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

		const chunks = await chunksOf(home, "guide/chunking.md");
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

		const chunks = await chunksOf(home, "guide/chunking.md");
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

		const links = await linksFrom(home, "bigquery-table/users.md");
		// Three of the four links in the body point inside the bundle; the fourth
		// is an external URL, and the one in the fenced block is a code sample.
		expect(
			links.map((link) => [link.kind, link.target_path, link.link_text]),
		).toEqual([
			["markdown", "bigquery-table/orders.md", "Orders table"],
			["markdown", "bigquery-table/sessions.md", "Sessions table"],
			["markdown", "bigquery-table/orders.md", "order columns"],
		]);
	});

	test("resolves a link that has a target and leaves the rest unresolved", async () => {
		const home = await bundledHome();

		await invoke(["sync"], home);

		const links = await linksFrom(home, "bigquery-table/users.md");
		expect(links.map((link) => link.target)).toEqual([
			"bigquery-table/orders.md",
			// `bigquery-table/sessions.md` is not written yet, so the edge is kept and
			// left unresolved rather than dropped.
			null,
			"bigquery-table/orders.md",
		]);
	});

	test("keeps the anchor and the sentence the link was written in", async () => {
		const home = await bundledHome();

		await invoke(["sync"], home);

		const [, , anchored] = await linksFrom(home, "bigquery-table/users.md");
		expect(anchored.anchor).toBe("columns");
		expect(anchored.target).toBe("bigquery-table/orders.md");
		expect(anchored.context).toBe(
			"`user_id` is the primary key, and the [order columns](orders.md#columns) are keyed by it too.",
		);
	});

	test("records a frontmatter citation as an edge of its own kind", async () => {
		const home = await bundledHome();

		await invoke(["sync"], home);

		const links = await linksFrom(home, "bigquery-table/orders.md");
		// The citation of `users.md` and the body mention of it are both edges,
		// told apart by their kind; the cited URL is outside the bundle.
		expect(
			links.map((link) => [link.kind, link.target, link.link_text]),
		).toEqual([
			["source", "bigquery-table/users.md", "Users table"],
			["markdown", "bigquery-table/users.md", "Users table"],
		]);
	});

	test("attributes a link to the chunk it was written in", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const [rows] = await sql<{ heading: string }>(
			home,
			"SELECT ch.heading FROM links l JOIN chunks ch ON ch.id = l.source_chunk_id" +
				" JOIN concepts c ON c.id = l.source_concept_id" +
				" WHERE c.path = 'bigquery-table/users.md' AND l.anchor = 'columns'",
		);

		expect(rows.heading).toBe("Columns");
	});

	test("writing the missing document resolves the link with no edit to the source", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);
		const sourceBefore = readFileSync(
			join(home, "docs", "bigquery-table", "users.md"),
			"utf8",
		);

		writeFileSync(
			join(home, "docs", "bigquery-table", "sessions.md"),
			"---\ntype: BigQuery Table\ntitle: Sessions table\n---\n\n# Sessions table\n\nOne row per session.\n",
		);
		await invoke(["sync"], home);

		expect((await linksFrom(home, "bigquery-table/users.md"))[1].target).toBe(
			"bigquery-table/sessions.md",
		);
		expect(
			readFileSync(join(home, "docs", "bigquery-table", "users.md"), "utf8"),
		).toBe(sourceBefore);
	});

	test("moving a document re-aims the relative links it wrote", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		mkdirSync(join(home, "docs", "moved"));
		renameSync(
			join(home, "docs", "bigquery-table", "users.md"),
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

		rmSync(join(home, "docs", "bigquery-table", "orders.md"));
		await invoke(["sync"], home);

		const links = await linksFrom(home, "bigquery-table/users.md");
		expect(links).toHaveLength(3);
		expect(links.map((link) => [link.target_path, link.target])).toEqual([
			["bigquery-table/orders.md", null],
			["bigquery-table/sessions.md", null],
			["bigquery-table/orders.md", null],
		]);
	});
});

describe("lattice rels", () => {
	test("reports outlinks, backlinks and unresolved links", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["rels", "bigquery-table/users"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		// Two body links out to the orders table, one citation and one body link
		// back from it, one link to a document that has not been written. Sharing
		// `bigquery-table/` with the orders table is not a relation.
		expect(result.stdout).toContain("Outgoing (2)");
		expect(result.stdout).toContain("Incoming (2)");
		expect(result.stdout).not.toContain("Siblings");
		expect(result.stdout).toContain("Unresolved (1)");
		expect(result.stdout).toContain("bigquery-table/orders.md");
		expect(result.stdout).toContain("bigquery-table/sessions.md");
	});

	test("takes a path as readily as an identifier", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const byPath = await invoke(["rels", "bigquery-table/users.md"], home);
		const byIdentifier = await invoke(["rels", "bigquery-table/users"], home);

		expect(byPath.code).toBe(0);
		expect(byPath.stdout).toBe(byIdentifier.stdout);
	});

	test("--json emits the three relations machine-readably", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(
			["rels", "bigquery-table/users", "--json"],
			home,
		);

		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(Object.keys(report)).toEqual([
			"concept",
			"outlinks",
			"backlinks",
			"unresolved",
		]);
		expect(report.concept.path).toBe("bigquery-table/users.md");
		expect(report.outlinks.map((link: { path: string }) => link.path)).toEqual([
			"bigquery-table/orders.md",
			"bigquery-table/orders.md",
		]);
		expect(
			report.backlinks.map((link: { path: string; kind: string }) => [
				link.path,
				link.kind,
			]),
		).toEqual([
			["bigquery-table/orders.md", "source"],
			["bigquery-table/orders.md", "markdown"],
		]);
		expect(
			report.unresolved.map(
				(link: { target_path: string }) => link.target_path,
			),
		).toEqual(["bigquery-table/sessions.md"]);
	});

	test("exits non-zero for a concept that is not indexed", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["rels", "bigquery-table/nowhere"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("bigquery-table/nowhere");
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
			"SELECT id, indexed_at FROM concepts WHERE path <> 'note/unverified.md' ORDER BY id",
		);
		const [idBefore] = await sql<{ id: number }>(
			home,
			"SELECT id FROM concepts WHERE path = 'note/unverified.md'",
		);

		writeFileSync(
			join(home, "docs", "note", "unverified.md"),
			"---\ntype: Note\ntitle: Scratch note\n---\n\n# Scratch note\n\nRewritten.\n",
		);
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("0 new, 1 changed");
		expect(
			await sql(
				home,
				"SELECT id, indexed_at FROM concepts WHERE path <> 'note/unverified.md' ORDER BY id",
			),
		).toEqual(untouchedBefore);
		expect((await chunksOf(home, "note/unverified.md"))[0].content).toContain(
			"Rewritten.",
		);
		// The concept is the path, so an edit keeps the identity it had.
		const [idAfter] = await sql<{ id: number }>(
			home,
			"SELECT id FROM concepts WHERE path = 'note/unverified.md'",
		);
		expect(idAfter.id).toBe(idBefore.id);
	});

	test("deleting a file removes its concept, chunks and tags", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);
		expect(await chunksOf(home, "bigquery-table/users.md")).not.toHaveLength(0);

		rmSync(join(home, "docs", "bigquery-table", "users.md"));
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("1 deleted");
		expect(
			await sql(
				home,
				"SELECT path FROM concepts WHERE path = 'bigquery-table/users.md'",
			),
		).toEqual([]);
		expect(await chunksOf(home, "bigquery-table/users.md")).toEqual([]);
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
			"SELECT id, indexed_at FROM concepts WHERE path = 'bigquery-table/users.md'",
		);

		renameSync(
			join(home, "docs", "bigquery-table", "users.md"),
			join(home, "docs", "bigquery-table", "accounts.md"),
		);
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("1 renamed");
		expect(
			await sql(
				home,
				"SELECT id, identifier, indexed_at FROM concepts WHERE path = 'bigquery-table/accounts.md'",
			),
		).toEqual([
			{
				id: before.id,
				identifier: "bigquery-table/accounts",
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
			{ n: 11 },
		]);
	});
});

describe("lattice status against a bundle", () => {
	test("reports what a sync would do and names the broken frontmatter", async () => {
		const home = await bundledHome();

		const before = await invoke(["status"], home);

		expect(before.code).toBe(0);
		expect(before.stdout).toContain("New:     11");
		expect(before.stdout).toContain("Changed: 0");
		expect(before.stdout).toContain("Deleted: 0");
		expect(before.stdout).toContain("note/broken.md");
		expect(before.stdout).toContain("note/plain.md");
		expect(before.stdout).not.toContain("bigquery-table/users.md");
	});

	test("reports a document filed outside its type's directory, before and after sync", async () => {
		const home = await bundledHome();
		mkdirSync(join(home, "docs", "misc"));
		writeFileSync(
			join(home, "docs", "misc", "x.md"),
			"---\ntype: Note\n---\n\n# Misfiled\n",
		);
		const message =
			"misc/x.md: filed under `misc/` but type `Note` belongs in `note/`";

		const before = await invoke(["status"], home);
		expect(before.stdout).toContain(message);

		const synced = await invoke(["sync"], home);
		expect(synced.stdout).toContain(message);

		const after = await invoke(["status"], home);
		expect(after.stdout).toContain(message);
	});

	test("reports an up-to-date bundle after a sync, then the next change", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const synced = await invoke(["status"], home);
		expect(synced.stdout).toContain("Concepts:   11");
		expect(synced.stdout).toContain("Up to date");

		writeFileSync(join(home, "docs", "note", "added.md"), "# Added\n\nNew.\n");
		rmSync(join(home, "docs", "note", "plain.md"));
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
				join(home, "docs", "note", `bulk-${i}.md`),
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
			{ n: 2011 },
		]);
		expect(
			await sql(
				home,
				"SELECT count(*) AS n FROM concepts WHERE id NOT IN (SELECT concept_id FROM chunks)",
			),
		).toEqual([{ n: 0 }]);
	});
});

/** A synced home holding the fixture bundle — the corpus every search test queries. */
async function searchableHome(): Promise<string> {
	const home = await bundledHome();
	await invoke(["sync"], home);
	return home;
}

interface SearchHit {
	path: string;
	title: string | null;
	type: string | null;
	status: string | null;
	trust: string;
	staleAfter: string | null;
	stale: boolean;
	score: number;
	expanded?: true;
	via?: { relation: string; from: string };
	chunks: Array<{
		ordinal: number;
		headingPath: string;
		startLine: number;
		endLine: number;
		startChar: number;
		endChar: number;
		snippet: string;
	}>;
}

async function search(
	home: string,
	argv: string[],
	env: Record<string, string> = {},
): Promise<{
	code: number;
	stderr: string;
	hits: SearchHit[];
	degraded?: boolean;
	degradedReason?: string | null;
}> {
	const result = await invoke(["search", ...argv, "--json"], home, env);
	const parsed = result.stdout === "" ? undefined : JSON.parse(result.stdout);
	return {
		code: result.code,
		stderr: result.stderr,
		hits: parsed?.hits ?? [],
		degraded: parsed?.degraded,
		degradedReason: parsed?.degradedReason,
	};
}

/**
 * The stub provider's synonym groups. Each group is a set of phrases that are
 * declared to mean the same thing; a text's vector has one dimension per group
 * it mentions. That is what lets a query and a document be semantically near
 * while sharing no words at all, which no deterministic hash could ever do.
 */
const HYBRID_GROUPS = [
	["Thermal throttle", "whisper mode"],
	["Airflow curve", "blower ramps"],
];

const HYBRID_ENV = {
	LATTICE_EMBED_PROVIDER: "stub",
	LATTICE_EMBED_STUB: JSON.stringify(HYBRID_GROUPS),
};

/** A synced home over the hybrid fixture bundle, embedded with the stub provider. */
async function hybridHome(): Promise<string> {
	const home = freshHome();
	await invoke(["init"], home);
	cpSync(FIXTURE_HYBRID, join(home, "docs"), { recursive: true });
	const synced = await invoke(["sync"], home, HYBRID_ENV);
	expect(synced.stderr).toBe("");
	return home;
}

describe("hybrid search", () => {
	test("a paraphrase sharing no words with the document still finds it", async () => {
		const home = await hybridHome();

		// Neither word appears anywhere in the bundle, so the keyword leg has
		// nothing to return at all: only the semantic leg can answer this.
		// `whisper mode` and the document's `Thermal throttle` share a group.
		for (const name of ["note/cooling.md", "reference/airflow-curve.md"]) {
			const source = readFileSync(join(home, "docs", name), "utf8");
			expect(source.toLowerCase()).not.toContain("whisper");
			expect(source.toLowerCase()).not.toContain("mode");
		}

		const { code, stderr, hits } = await search(
			home,
			["whisper mode"],
			HYBRID_ENV,
		);

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(hits[0].path).toBe("note/cooling.md");
	});

	test("a passage only one leg ranks highly still appears in the fused results", async () => {
		const home = await hybridHome();

		// Each half of this query is answered by one leg and neither by both:
		// `XJ_4471` is written in `note/serial.md` and is in no vector group,
		// and `whisper mode` is in no document and is a group with
		// `note/cooling.md`'s title.
		const semanticOnly = await search(
			home,
			["whisper mode", "--no-expand"],
			HYBRID_ENV,
		);
		expect(semanticOnly.hits.map((hit) => hit.path)).toEqual([
			"note/cooling.md",
		]);

		const keywordOnly = await search(
			home,
			["XJ_4471", "--no-expand"],
			HYBRID_ENV,
		);
		expect(keywordOnly.hits.map((hit) => hit.path)).toEqual(["note/serial.md"]);

		const both = await search(home, ["XJ_4471 whisper mode"], HYBRID_ENV);

		expect(both.code).toBe(0);
		expect(both.hits.map((hit) => hit.path)).toContain("note/serial.md");
		expect(both.hits.map((hit) => hit.path)).toContain("note/cooling.md");
	});

	test("the concept vector decides between results the legs tied", async () => {
		const home = await hybridHome();

		// Each half of this query is answered by exactly one leg, and each leg
		// puts its answer first, so the fusion hands both documents the same
		// score. Left tied, they would come back in path order — `note/` before
		// `note/`. Only `note/cooling.md` names a vector group in its
		// title and description, which is what a concept vector is built from.
		const { code, hits } = await search(
			home,
			["XJ_4471 whisper mode", "--no-expand"],
			HYBRID_ENV,
		);

		expect(code).toBe(0);
		expect(hits.map((hit) => hit.path)).toEqual([
			"note/cooling.md",
			"note/serial.md",
		]);
	});

	test("the concept vector never introduces a result of its own", async () => {
		const home = await hybridHome();

		// `note/acoustics.md` says "whisper mode" only in its frontmatter
		// description, which is what a concept vector is built from — so its
		// CONCEPT vector is as near the query as it can be, while neither of
		// its passages matches either leg. A third ranked list would surface
		// it; a tiebreak cannot.
		const source = readFileSync(
			join(home, "docs", "note", "acoustics.md"),
			"utf8",
		);
		const [, frontmatter, body] = source.split("---\n");
		expect(frontmatter.toLowerCase()).toContain("whisper mode");
		expect(body.toLowerCase()).not.toContain("whisper");

		const { hits } = await search(home, ["whisper mode"], HYBRID_ENV);

		expect(hits.map((hit) => hit.path)).not.toContain("note/acoustics.md");
	});

	test("says so when the semantic leg cannot run, and still answers", async () => {
		const home = await hybridHome();

		const broken = await search(home, ["XJ_4471", "--no-expand"], {
			LATTICE_EMBED_PROVIDER: "no-such-model",
		});

		expect(broken.code).toBe(0);
		expect(broken.degraded).toBe(true);
		expect(broken.degradedReason).toContain("no-such-model");
		// Keyword-only, but still an answer.
		expect(broken.hits.map((hit) => hit.path)).toEqual(["note/serial.md"]);

		const healthy = await search(home, ["XJ_4471"], HYBRID_ENV);
		expect(healthy.degraded).toBe(false);
		expect(healthy.degradedReason).toBeNull();
	});

	test("refuses a corpus embedded by a different model", async () => {
		const home = await hybridHome();

		// The bundle was embedded with the stub provider; the default hash
		// provider can embed this query but has nothing to compare it against.
		// Answering on the keyword leg alone would look like an ordinary
		// result, so the mismatch is refused and named instead.
		const result = await invoke(["search", "XJ_4471"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("stub-");
		expect(result.stderr).toContain("hash-512");
		expect(result.stderr).toContain("lattice embed --reembed");
	});

	test("--require-embeddings turns degradation into a non-zero exit", async () => {
		const home = await hybridHome();

		const refused = await invoke(
			["search", "XJ_4471", "--require-embeddings", "--json"],
			home,
			{ LATTICE_EMBED_PROVIDER: "no-such-model" },
		);

		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("--require-embeddings");
		expect(refused.stderr).toContain("no-such-model");

		const allowed = await invoke(
			["search", "XJ_4471", "--require-embeddings", "--json"],
			home,
			HYBRID_ENV,
		);

		expect(allowed.code).toBe(0);
		expect(allowed.stderr).toBe("");
	});
});

describe("concept-level search", () => {
	test("answers with documents rather than passages", async () => {
		const home = await hybridHome();

		const { code, hits } = await search(
			home,
			["whisper mode", "--concepts"],
			HYBRID_ENV,
		);

		expect(code).toBe(0);
		expect(hits.every((hit) => hit.chunks.length === 0)).toBe(true);
		expect(hits.map((hit) => hit.path)).toContain("note/cooling.md");

		// At concept level the concept vector IS a ranked list, so the document
		// that says "whisper mode" only in its frontmatter — which no passage
		// search returns — is a legitimate answer here.
		expect(hits.map((hit) => hit.path)).toContain("note/acoustics.md");
		expect(
			(await search(home, ["whisper mode"], HYBRID_ENV)).hits.map(
				(hit) => hit.path,
			),
		).not.toContain("note/acoustics.md");
	});

	test("applies the same filters as passage search", async () => {
		const home = await hybridHome();

		const { hits } = await search(
			home,
			["whisper mode", "--concepts", "--dir", "note"],
			HYBRID_ENV,
		);

		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((hit) => hit.path.startsWith("note/"))).toBe(true);
	});
});

describe("graph expansion", () => {
	test("reaches a link target and a backlink source, but not a directory neighbour", async () => {
		const home = await hybridHome();

		// `note/cooling.md` links to `reference/airflow-curve.md`,
		// `reference/dust.md` links back to it, and `note/chassis.md` sits beside
		// it in `note/` with no link either way — which is no relation at all.
		const { code, hits } = await search(home, ["Thermal throttle"], HYBRID_ENV);

		expect(code).toBe(0);

		const direct = hits.filter((hit) => hit.expanded !== true);
		const expanded = hits.filter((hit) => hit.expanded === true);
		expect(direct.map((hit) => hit.path)).toEqual(["note/cooling.md"]);

		const byPath = new Map(expanded.map((hit) => [hit.path, hit]));
		expect(byPath.get("reference/airflow-curve.md")?.via).toEqual({
			relation: "link",
			from: "note/cooling.md",
		});
		expect(byPath.get("reference/dust.md")?.via).toEqual({
			relation: "backlink",
			from: "note/cooling.md",
		});
		expect(hits.map((hit) => hit.path)).not.toContain("note/chassis.md");
		expect(expanded.map((hit) => hit.path).sort()).toEqual([
			"reference/airflow-curve.md",
			"reference/dust.md",
		]);

		// Never above an actual answer.
		const lowestDirect = Math.min(...direct.map((hit) => hit.score));
		for (const hit of expanded) {
			expect(hit.score).toBeLessThan(lowestDirect);
		}
		expect(hits.indexOf(direct[0])).toBeLessThan(hits.indexOf(expanded[0]));
	});

	test("expansion is capped, deduplicated and can be turned off", async () => {
		const home = await hybridHome();

		const capped = await search(
			home,
			["Thermal throttle", "--expand", "1"],
			HYBRID_ENV,
		);
		expect(capped.hits.filter((hit) => hit.expanded === true)).toHaveLength(1);

		const off = await search(
			home,
			["Thermal throttle", "--no-expand"],
			HYBRID_ENV,
		);
		expect(off.hits.every((hit) => hit.expanded !== true)).toBe(true);

		// A neighbour that is already an answer is not repeated as a neighbour:
		// this query matches both ends of the `cooling` → `airflow-curve` edge.
		const overlapping = await search(
			home,
			["Thermal throttle blower ramps"],
			HYBRID_ENV,
		);
		const paths = overlapping.hits.map((hit) => hit.path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(
			overlapping.hits.find((hit) => hit.path === "reference/airflow-curve.md")
				?.expanded,
		).toBeUndefined();
	});

	test("expansion honours the filters the direct hits were found under", async () => {
		const home = await hybridHome();

		const { hits } = await search(
			home,
			["Thermal throttle", "--dir", "note"],
			HYBRID_ENV,
		);

		// `reference/` is outside the filter, so the link and the backlink are not
		// pulled back in through the graph.
		expect(hits.map((hit) => hit.path)).toContain("note/cooling.md");
		expect(hits.every((hit) => hit.path.startsWith("note/"))).toBe(true);
		expect(hits.every((hit) => hit.expanded !== true)).toBe(true);
	});
});

describe("lattice search", () => {
	test("returns the passages holding an exact identifier, grouped by concept", async () => {
		const home = await searchableHome();

		const { code, stderr, hits } = await search(home, ["user_id"]);

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(hits.map((hit) => hit.path)).toEqual(["bigquery-table/users.md"]);

		const [users] = hits;
		expect(users.title).toBe("Users table");
		expect(users.type).toBe("BigQuery Table");
		expect(users.status).toBe("stable");
		expect(users.trust).toBe("human-reviewed");
		expect(users.staleAfter).toBe("2027-01-01T00:00:00Z");
		expect(users.stale).toBe(false);
		expect(users.score).toBeGreaterThan(0);

		// `user_id` is written under the "Columns" heading of `bigquery-table/users.md`.
		expect(users.chunks).toHaveLength(1);
		expect(users.chunks[0].headingPath).toBe("Users table > Columns");
		expect(users.chunks[0].snippet).toContain("user_id");
	});

	test("a natural-language question with punctuation and operator words still returns candidates", async () => {
		const home = await searchableHome();

		const { code, stderr, hits } = await search(home, [
			'What is the "user_id" column AND the primary-key, really?',
		]);

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(hits.map((hit) => hit.path)).toContain("bigquery-table/users.md");
	});

	test("a query holding no searchable text reports no matches rather than failing", async () => {
		const home = await searchableHome();

		const { code, stderr, hits } = await search(home, ['*?!( "" )-']);

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(hits).toEqual([]);
	});

	test("a title hit outranks a heading hit, which outranks a body hit", async () => {
		const home = await searchableHome();

		const { code, hits } = await search(home, ["sentinel", "--no-expand"]);

		expect(code).toBe(0);
		// `gauge/title-match.md` writes "sentinel" only in its frontmatter title,
		// `gauge/heading-match.md` only in its heading, `gauge/body-match.md`
		// only in a paragraph.
		expect(hits.map((hit) => hit.path)).toEqual([
			"gauge/title-match.md",
			"gauge/heading-match.md",
			"gauge/body-match.md",
		]);
	});

	test("caps the passages shown per concept and the concepts shown", async () => {
		const home = await searchableHome();

		// "Paragraph" is repeated across the split pieces of one long section in
		// `guide/chunking.md`, so the concept holds more matching passages than
		// it is allowed to show.
		const everything = await search(home, ["paragraph", "--no-expand"]);
		const [guide] = everything.hits.filter(
			(hit) => hit.path === "guide/chunking.md",
		);
		expect(guide.chunks.length).toBe(2);

		const narrowed = await search(home, [
			"paragraph",
			"--chunks",
			"1",
			"--no-expand",
		]);
		expect(narrowed.hits[0].chunks).toHaveLength(1);

		const limited = await search(home, [
			"gauge",
			"--limit",
			"2",
			"--no-expand",
		]);
		expect(limited.hits).toHaveLength(2);
		expect(
			(await search(home, ["gauge", "--no-expand"])).hits.length,
		).toBeGreaterThan(2);
	});

	test("refuses a cap that is not a positive whole number", async () => {
		const home = await searchableHome();

		const result = await invoke(["search", "gauge", "--limit", "0"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--limit expects a positive whole number");
	});

	test("each filter narrows the results, and filters compose", async () => {
		const home = await searchableHome();

		// No document holds both words, so this falls back to matching either and
		// spans the `bigquery-table/` and `gauge/` fixtures at once.
		const broad = ["table", "gauge"];
		const paths = async (extra: string[]) =>
			(await search(home, [broad.join(" "), ...extra])).hits.map(
				(hit) => hit.path,
			);

		expect(await paths([])).toContain("bigquery-table/users.md");
		expect(await paths([])).toContain("gauge/title-match.md");

		expect(await paths(["--type", "BigQuery Table"])).toEqual([
			"bigquery-table/users.md",
		]);
		expect(await paths(["--tag", "core"])).toEqual(["bigquery-table/users.md"]);
		expect(await paths(["--dir", "bigquery-table"])).toEqual([
			"bigquery-table/users.md",
		]);
		expect(await paths(["--status", "stable"])).toEqual([
			"bigquery-table/users.md",
		]);
		expect(await paths(["--trust", "human-reviewed"])).toEqual([
			"bigquery-table/users.md",
		]);

		expect(
			(await paths(["--type", "Gauge"])).every((path) =>
				path.startsWith("gauge/"),
			),
		).toBe(true);

		// Composed filters are an AND: a Gauge is never in `bigquery-table/`.
		expect(await paths(["--type", "Gauge", "--dir", "bigquery-table"])).toEqual(
			[],
		);
		expect(await paths(["--type", "Gauge", "--tag", "rank"])).toEqual(
			await paths(["--type", "Gauge"]),
		);
	});

	test("leaves a deprecated concept out until it is asked for", async () => {
		const home = await searchableHome();

		// `bigquery-table/orders.md` is the only fixture with `status: deprecated`.
		expect((await search(home, ["purchases", "--no-expand"])).hits).toEqual([]);

		expect(
			(
				await search(home, ["purchases", "--include-deprecated", "--no-expand"])
			).hits.map((hit) => hit.path),
		).toEqual(["bigquery-table/orders.md"]);

		expect(
			(
				await search(home, [
					"purchases",
					"--status",
					"deprecated",
					"--no-expand",
				])
			).hits.map((hit) => hit.path),
		).toEqual(["bigquery-table/orders.md"]);
	});

	test("ranks a concept past its staleness date below an equal fresh one", async () => {
		const home = await searchableHome();

		// The two widget fixtures are identical but for their `stale_after`:
		// 2030 and 2020. Judged from 2026, only the second is past it.
		const { hits } = await search(home, [
			"widget",
			"--as-of",
			"2026-01-01T00:00:00Z",
			"--no-expand",
		]);

		expect(hits.map((hit) => hit.path)).toEqual([
			"gauge/fresh-widget.md",
			"gauge/stale-widget.md",
		]);
		expect(hits.map((hit) => hit.stale)).toEqual([false, true]);
		expect(hits[0].score).toBeGreaterThan(hits[1].score);

		// Judged from before both dates, neither is stale and the tie is broken
		// by path rather than by a penalty.
		const early = await search(home, [
			"widget",
			"--as-of",
			"2019-01-01T00:00:00Z",
			"--no-expand",
		]);
		expect(early.hits.map((hit) => hit.stale)).toEqual([false, false]);
	});

	test("refuses an --as-of that is not a date", async () => {
		const home = await searchableHome();

		const result = await invoke(["search", "widget", "--as-of", "soon"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--as-of expects a date");
	});

	test("reports offsets that slice the matching passage out of the source file", async () => {
		const home = await searchableHome();

		const { hits } = await search(home, ["fenced"]);
		const [guide] = hits.filter((hit) => hit.path === "guide/chunking.md");
		const chunk = guide.chunks[0];

		const raw = readFileSync(
			join(home, "docs", "guide", "chunking.md"),
			"utf8",
		);
		expect(raw.slice(chunk.startChar, chunk.endChar)).toContain("Fenced code");
		expect(raw.split("\n")[chunk.startLine - 1]).toBe("## Fenced code");
		expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
	});

	test("prints a readable listing without --json, and says so when nothing matches", async () => {
		const home = await searchableHome();

		const found = await invoke(["search", "user_id"], home);

		expect(found.code).toBe(0);
		expect(found.stderr).toBe("");
		expect(found.stdout).toContain("bigquery-table/users.md — Users table");
		expect(found.stdout).toContain(
			"[BigQuery Table · stable · human-reviewed]",
		);
		expect(found.stdout).toContain("user_id");

		const missing = await invoke(["search", "zzzznothinghere"], home);

		expect(missing.code).toBe(0);
		expect(missing.stdout).toBe("No matches.\n");
	});

	test("exits non-zero when there is no index to search", async () => {
		const result = await invoke(["search", "anything"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("No Lattice index");
		expect(result.stderr).toContain("lattice init");
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
			"bigquery-table/orders.md",
			"bigquery-table/users.md",
			"gauge/body-match.md",
			"gauge/fresh-widget.md",
			"gauge/heading-match.md",
			"gauge/stale-widget.md",
			"gauge/title-match.md",
			"guide/chunking.md",
			"note/unverified.md",
		]);

		// Two concepts differing only in body text would share a vector; these
		// differ in title and tags, so they must not.
		const [pair] = await sql<{ same: number }>(
			home,
			"SELECT (SELECT vector FROM concept_embeddings e JOIN concepts c ON c.id = e.concept_id" +
				"   WHERE c.path = 'bigquery-table/users.md')" +
				" = (SELECT vector FROM concept_embeddings e JOIN concepts c ON c.id = e.concept_id" +
				"   WHERE c.path = 'bigquery-table/orders.md') AS same",
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
			join(home, "docs", "guide", "chunking.md"),
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

		const [{ n: chunks }] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunks",
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Chunks:     ${chunks}`);
		expect(result.stdout).toContain(`Embeddings: ${chunks}`);
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

describe("search at scale", () => {
	/**
	 * The scale a personal knowledge base actually reaches. Each document's
	 * sections are short enough to merge back into one passage, so this is
	 * 3,600 embedded passages — and the semantic leg has no index to lean on,
	 * it decodes and scores every one of them on every query.
	 */
	const DOCUMENTS = 3600;
	const BUDGET_MS = 1000;

	test("answers within the budget on a corpus at that scale", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		mkdirSync(join(home, "docs", "corpus"), { recursive: true });
		for (let i = 0; i < DOCUMENTS; i++) {
			writeFileSync(
				join(home, "docs", "corpus", `note-${i}.md`),
				`---\ntype: Note\ntitle: Note ${i}\n---\n\n` +
					`# Overview\n\nThis note concerns topic ${i % 37} and its neighbours.\n\n` +
					`## Detail\n\nMeasurements for gauge ${i} were taken on the bench.\n`,
			);
		}
		expect((await invoke(["sync"], home)).stderr).toBe("");

		// A budget is only meaningful if the scan it is measuring is real: the
		// semantic leg must have a vector for every passage to work through.
		const [embedded] = await sql<{ n: number }>(
			home,
			"SELECT count(*) AS n FROM chunk_embeddings",
		);
		expect(embedded.n).toBeGreaterThanOrEqual(DOCUMENTS);

		const started = performance.now();
		const { code, hits, degraded } = await search(home, [
			"measurements taken on the bench",
		]);
		const elapsed = performance.now() - started;

		expect(code).toBe(0);
		expect(degraded).toBe(false);
		expect(hits.length).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	}, 120_000);
});

/**
 * The `/research` command tells its user exactly what a research document
 * looks like. This is that document — the template from
 * `commands/research.md`, minus its "content sections as needed" placeholder —
 * proving the command teaches a shape the engine actually indexes.
 */
const RESEARCH_TEMPLATE = `---
type: Research
title: Tesla Model S value retention
description: How well the Model S holds its resale value.
status: draft
tags: [tesla, resale]
generated: { by: agent:claude-code/research, at: 2026-09-20T00:00:00Z }
sources:
  - ../bigquery-table/users.md
  - https://example.com/depreciation
---

# Tesla Model S value retention

## Key findings

Depreciation flattens after the fourth year.

## Sources

1. [Depreciation study](https://example.com/depreciation)
`;

describe("the /research document template", () => {
	test("indexes with its type, title, description and tags, and cites its in-bundle source", async () => {
		const home = await bundledHome();
		// Filed under the directory its type names, as the skill instructs.
		mkdirSync(join(home, "docs", "research"), { recursive: true });
		// The reserved index name: navigation, never a concept of its own.
		writeFileSync(
			join(home, "docs", "research", "index.md"),
			"# Research\n\n- [Value retention](tesla-model-s-value-retention.md)\n",
		);
		writeFileSync(
			join(home, "docs", "research", "tesla-model-s-value-retention.md"),
			RESEARCH_TEMPLATE,
		);

		const synced = await invoke(["sync"], home);
		expect(synced.code).toBe(0);

		// The fixture bundle has its own deliberately broken files; the point
		// here is that the template is not among them.
		const status = await invoke(["status"], home);
		expect(status.stdout).not.toContain(
			"research/tesla-model-s-value-retention.md:",
		);

		// The promoted columns, read back through search rather than the database.
		const found = await invoke(
			["search", "depreciation", "--json", "--no-expand"],
			home,
		);
		const hit = JSON.parse(found.stdout).hits.find(
			(candidate: { path: string }) =>
				candidate.path === "research/tesla-model-s-value-retention.md",
		);
		expect(hit).toMatchObject({
			type: "Research",
			title: "Tesla Model S value retention",
			status: "draft",
		});

		// The description is indexed too: it is findable by its own words.
		const byDescription = await invoke(
			["search", "resale value", "--json", "--no-expand"],
			home,
		);
		expect(
			JSON.parse(byDescription.stdout).hits.map(
				(candidate: { path: string }) => candidate.path,
			),
		).toContain("research/tesla-model-s-value-retention.md");

		// Both tags are on the concept, so either one filters to it.
		for (const tag of ["tesla", "resale"]) {
			const filtered = await invoke(
				["search", "depreciation", "--json", "--no-expand", "--tag", tag],
				home,
			);
			expect(
				JSON.parse(filtered.stdout).hits.map(
					(candidate: { path: string }) => candidate.path,
				),
			).toContain("research/tesla-model-s-value-retention.md");
		}

		// The in-bundle citation is an edge; the external URL is not.
		const rels = await invoke(
			["rels", "research/tesla-model-s-value-retention.md", "--json"],
			home,
		);
		expect(JSON.parse(rels.stdout).outlinks).toContainEqual(
			expect.objectContaining({
				path: "bigquery-table/users.md",
				kind: "source",
			}),
		);

		// The reserved index file is navigation, so it is not indexed as a concept.
		const indexed = await invoke(["rels", "research/index.md", "--json"], home);
		expect(indexed.code).not.toBe(0);
	});
});
