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
import { dirname, join } from "node:path";
import { runCli } from "./run.js";

const FIXTURE_BUNDLE = join(import.meta.dir, "..", "fixtures", "bundle");

/**
 * Every test drives the CLI through its single seam, `runCli`, with an
 * isolated LATTICE_HOME. Nothing here opens the database directly.
 */
function freshHome(): string {
	return mkdtempSync(join(tmpdir(), "lattice-test-"));
}

function invoke(argv: string[], home: string = freshHome()) {
	return runCli({ argv, env: { LATTICE_HOME: home } });
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
	raw_target: string;
	target_path: string | null;
	target: string | null;
	target_anchor: string | null;
	link_text: string | null;
	kind: string;
	context: string | null;
}

/** Every link the index holds, named by the paths at both ends. */
async function linksOf(home: string, sourcePath?: string): Promise<LinkRow[]> {
	return sql<LinkRow>(
		home,
		"SELECT s.path AS source, l.raw_target, l.target_path, t.path AS target," +
			" l.target_anchor, l.link_text, l.kind, l.context" +
			" FROM links l JOIN concepts s ON s.id = l.source_concept_id" +
			" LEFT JOIN concepts t ON t.id = l.target_concept_id" +
			(sourcePath === undefined ? "" : ` WHERE s.path = '${sourcePath}'`) +
			" ORDER BY s.path, l.id",
	);
}

/**
 * Sync, and fail here if it did not succeed — so a sync that broke can never
 * be read downstream as "this document has no links".
 */
async function syncOk(home: string): Promise<void> {
	const result = await invoke(["sync"], home);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
}

/** Write a document into the bundle, creating its directory if need be. */
function writeDoc(home: string, path: string, contents: string): void {
	const absolute = join(home, "docs", ...path.split("/"));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

describe("authored links", () => {
	test("the fixture bundle's own graph is what a sync records", async () => {
		const home = await bundledHome();

		await syncOk(home);

		// `concepts/orders.md` cites users as a source, links to it in the body,
		// and links to a purchases table nobody has written. Its code span and
		// its external link are neither.
		expect(await linksOf(home, "concepts/orders.md")).toMatchObject([
			{ kind: "source", target: "concepts/users.md", target_anchor: null },
			{
				kind: "markdown",
				target: "concepts/users.md",
				target_anchor: "columns",
				link_text: "the users table",
			},
			{
				kind: "markdown",
				target_path: "concepts/purchases.md",
				target: null,
				link_text: "the purchases table",
			},
		]);
	});

	test("a markdown link to another document becomes an edge", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			[
				"---",
				"type: Note",
				"title: Linker",
				"---",
				"",
				"# Linker",
				"",
				"The account record lives in [the users table](../concepts/users.md).",
				"",
			].join("\n"),
		);

		await syncOk(home);

		expect(await linksOf(home, "notes/linker.md")).toEqual([
			{
				source: "notes/linker.md",
				raw_target: "../concepts/users.md",
				target_path: "concepts/users.md",
				target: "concepts/users.md",
				target_anchor: null,
				link_text: "the users table",
				kind: "markdown",
				context:
					"The account record lives in [the users table](../concepts/users.md).",
			},
		]);
	});

	test("a wikilink is an edge, and carries its alias as the link text", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			"# Linker\n\nSee [[../concepts/orders|the orders table]] and [[../concepts/users]].\n",
		);

		await syncOk(home);

		const links = await linksOf(home, "notes/linker.md");
		expect(
			links.map((link) => [link.kind, link.target, link.link_text]),
		).toEqual([
			["wikilink", "concepts/orders.md", "the orders table"],
			["wikilink", "concepts/users.md", null],
		]);
	});

	test("links in fenced code and code spans are samples, not edges", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			[
				"# Linker",
				"",
				"Write `[a span](../concepts/users.md)` to link, like this:",
				"",
				"```md",
				"[a fenced link](../concepts/users.md)",
				"[[../concepts/orders]]",
				"```",
				"",
				"~~~",
				"[a tilde-fenced link](../concepts/users.md)",
				"~~~",
				"",
				"Only [this one](../concepts/orders.md) counts.",
				"",
			].join("\n"),
		);

		await syncOk(home);

		expect(
			(await linksOf(home, "notes/linker.md")).map((link) => link.raw_target),
		).toEqual(["../concepts/orders.md"]);
	});

	test("external targets are never stored", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			[
				"# Linker",
				"",
				"See [the site](https://example.com/concepts/users.md),",
				"[the host](//example.com/users.md),",
				"[the author](mailto:someone@example.com),",
				"[[https://example.com/wiki]]",
				"and [this section](#linker).",
				"",
			].join("\n"),
		);

		await syncOk(home);

		expect(await linksOf(home, "notes/linker.md")).toEqual([]);
	});

	test("a target that climbs out of the bundle is not an edge", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			"# Linker\n\nNot ours: [escape](../../elsewhere/secrets.md).\n",
		);

		await syncOk(home);

		expect(await linksOf(home, "notes/linker.md")).toEqual([]);
	});

	test("an anchor is kept and still resolves to the target document", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			"# Linker\n\nThe key is in [the columns](../concepts/users.md#columns).\n",
		);

		await syncOk(home);

		const [link] = await linksOf(home, "notes/linker.md");
		expect(link.target).toBe("concepts/users.md");
		expect(link.target_anchor).toBe("columns");
		expect(link.link_text).toBe("the columns");
	});

	test("a cited source inside the bundle is an edge of its own kind", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/derived.md",
			[
				"---",
				"type: Note",
				"title: Derived",
				"sources:",
				"  - concepts/users.md",
				"  - https://example.com/elsewhere",
				"---",
				"",
				"# Derived",
				"",
				"Drawn from [the orders table](../concepts/orders.md).",
				"",
			].join("\n"),
		);

		await syncOk(home);

		expect(
			(await linksOf(home, "notes/derived.md")).map((link) => [
				link.kind,
				link.target,
			]),
		).toEqual([
			["source", "concepts/users.md"],
			["markdown", "concepts/orders.md"],
		]);
	});

	test("a link to a document nobody wrote is kept, unresolved", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			"# Linker\n\nOne day there will be [a purchases table](../concepts/purchases.md).\n",
		);

		await syncOk(home);

		expect(await linksOf(home, "notes/linker.md")).toMatchObject([
			{ target_path: "concepts/purchases.md", target: null },
		]);
	});

	test("writing the missing document resolves the link with no edit to the source", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			"# Linker\n\nOne day there will be [a purchases table](../concepts/purchases.md).\n",
		);
		await syncOk(home);
		const sourceBefore = readFileSync(
			join(home, "docs", "notes", "linker.md"),
			"utf8",
		);

		writeDoc(
			home,
			"concepts/purchases.md",
			"---\ntype: BigQuery Table\ntitle: Purchases table\n---\n\n# Purchases table\n\nIt exists now.\n",
		);
		const result = await invoke(["sync"], home);

		expect(result.code).toBe(0);
		expect(await linksOf(home, "notes/linker.md")).toMatchObject([
			{ target_path: "concepts/purchases.md", target: "concepts/purchases.md" },
		]);
		expect(readFileSync(join(home, "docs", "notes", "linker.md"), "utf8")).toBe(
			sourceBefore,
		);
	});

	test("deleting a target leaves its inbound links in place, unresolved", async () => {
		const home = await bundledHome();
		writeDoc(
			home,
			"notes/linker.md",
			"# Linker\n\nThe account record is [the users table](../concepts/users.md).\n",
		);
		await syncOk(home);
		expect(await linksOf(home, "notes/linker.md")).toMatchObject([
			{ target: "concepts/users.md" },
		]);

		rmSync(join(home, "docs", "concepts", "users.md"));
		await syncOk(home);

		expect(await linksOf(home, "notes/linker.md")).toMatchObject([
			{ target_path: "concepts/users.md", target: null },
		]);
	});
});

/**
 * The fixture bundle, synced. Its own link graph is the fixture here:
 * `concepts/orders.md` cites `concepts/users.md` as a source, links to it in
 * the body, and links to a purchases table nobody has written.
 */
async function linkedHome(): Promise<string> {
	const home = await bundledHome();
	await syncOk(home);
	return home;
}

describe("lattice rels", () => {
	test("reports outlinks, backlinks, siblings and unresolved links", async () => {
		const home = await linkedHome();

		const result = await invoke(["rels", "concepts/orders"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("concepts/orders.md");
		// What it links to, what links back, what it points at that nobody has
		// written, and what sits beside it.
		expect(result.stdout).toContain("Links to (2)");
		expect(result.stdout).toContain("concepts/users.md");
		expect(result.stdout).toContain("Unresolved (1)");
		expect(result.stdout).toContain("concepts/purchases.md");
		expect(result.stdout).toContain("Siblings (1)");

		// The other end of the same edges.
		const users = await invoke(["rels", "concepts/users"], home);
		expect(users.stdout).toContain("Linked from (2)");
		expect(users.stdout).toContain("concepts/orders.md");
	});

	test("--json prints the same four groups as machine-readable output", async () => {
		const home = await linkedHome();

		const result = await invoke(["rels", "concepts/orders", "--json"], home);

		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.concept).toMatchObject({
			path: "concepts/orders.md",
			identifier: "concepts/orders",
			title: "Orders table",
		});
		// The cited source and the body link are both edges to the same
		// document, and stay distinguishable by kind.
		expect(report.outlinks).toMatchObject([
			{ path: "concepts/users.md", kind: "source" },
			{
				path: "concepts/users.md",
				kind: "markdown",
				text: "the users table",
				anchor: "columns",
			},
		]);
		expect(report.backlinks).toEqual([]);
		expect(report.unresolved).toMatchObject([
			{ target_path: "concepts/purchases.md", text: "the purchases table" },
		]);
		expect(report.siblings).toMatchObject([{ path: "concepts/users.md" }]);
	});

	test("accepts a path, an identifier or a title", async () => {
		const home = await linkedHome();

		for (const name of ["concepts/users.md", "concepts/users", "Users table"]) {
			const result = await invoke(["rels", name, "--json"], home);
			expect(JSON.parse(result.stdout).concept.path).toBe("concepts/users.md");
		}
	});

	test("exits non-zero when nothing matches", async () => {
		const home = await linkedHome();

		const result = await invoke(["rels", "concepts/nobody"], home);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("concepts/nobody");
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
			env: { ...process.env, LATTICE_HOME: home },
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
