import { describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
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
			"search/body-match.md",
			"search/fresh-widget.md",
			"search/heading-match.md",
			"search/stale-widget.md",
			"search/title-match.md",
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
			{ path: "search/body-match.md", tag: "rank" },
			{ path: "search/fresh-widget.md", tag: "rank" },
			{ path: "search/heading-match.md", tag: "rank" },
			{ path: "search/stale-widget.md", tag: "rank" },
			{ path: "search/title-match.md", tag: "rank" },
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
			{ path: "search/body-match.md", trust: "unverified" },
			{ path: "search/fresh-widget.md", trust: "unverified" },
			{ path: "search/heading-match.md", trust: "unverified" },
			{ path: "search/stale-widget.md", trust: "unverified" },
			{ path: "search/title-match.md", trust: "unverified" },
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
		expect(before.stdout).toContain("notes/broken.md");
		expect(before.stdout).toContain("notes/plain.md");
		expect(before.stdout).not.toContain("concepts/users.md");
	});

	test("reports an up-to-date bundle after a sync, then the next change", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const synced = await invoke(["status"], home);
		expect(synced.stdout).toContain("Concepts:   11");
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
): Promise<{ code: number; stderr: string; hits: SearchHit[] }> {
	const result = await invoke(["search", ...argv, "--json"], home);
	return {
		code: result.code,
		stderr: result.stderr,
		hits: result.stdout === "" ? [] : JSON.parse(result.stdout).hits,
	};
}

describe("lattice search", () => {
	test("returns the passages holding an exact identifier, grouped by concept", async () => {
		const home = await searchableHome();

		const { code, stderr, hits } = await search(home, ["user_id"]);

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(hits.map((hit) => hit.path)).toEqual(["concepts/users.md"]);

		const [users] = hits;
		expect(users.title).toBe("Users table");
		expect(users.type).toBe("BigQuery Table");
		expect(users.status).toBe("stable");
		expect(users.trust).toBe("human-reviewed");
		expect(users.staleAfter).toBe("2027-01-01T00:00:00Z");
		expect(users.stale).toBe(false);
		expect(users.score).toBeGreaterThan(0);

		// `concepts/users.md` is short enough that its sections merge into one
		// passage, headed by the document's own title.
		expect(users.chunks).toHaveLength(1);
		expect(users.chunks[0].headingPath).toBe("Users table");
		expect(users.chunks[0].snippet).toContain("user_id");
	});

	test("a natural-language question with punctuation and operator words still returns candidates", async () => {
		const home = await searchableHome();

		const { code, stderr, hits } = await search(home, [
			'What is the "user_id" column AND the primary-key, really?',
		]);

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(hits.map((hit) => hit.path)).toContain("concepts/users.md");
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

		const { code, hits } = await search(home, ["sentinel"]);

		expect(code).toBe(0);
		// `search/title-match.md` writes "sentinel" only in its frontmatter title,
		// `search/heading-match.md` only in its heading, `search/body-match.md`
		// only in a paragraph.
		expect(hits.map((hit) => hit.path)).toEqual([
			"search/title-match.md",
			"search/heading-match.md",
			"search/body-match.md",
		]);
	});

	test("caps the passages shown per concept and the concepts shown", async () => {
		const home = await searchableHome();

		// "Paragraph" is repeated across the split pieces of one long section in
		// `guides/chunking.md`, so the concept holds more matching passages than
		// it is allowed to show.
		const everything = await search(home, ["paragraph"]);
		const [guide] = everything.hits.filter(
			(hit) => hit.path === "guides/chunking.md",
		);
		expect(guide.chunks.length).toBe(2);

		const narrowed = await search(home, ["paragraph", "--chunks", "1"]);
		expect(narrowed.hits[0].chunks).toHaveLength(1);

		const limited = await search(home, ["gauge", "--limit", "2"]);
		expect(limited.hits).toHaveLength(2);
		expect((await search(home, ["gauge"])).hits.length).toBeGreaterThan(2);
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
		// spans the `concepts/` and `search/` fixtures at once.
		const broad = ["table", "gauge"];
		const paths = async (extra: string[]) =>
			(await search(home, [broad.join(" "), ...extra])).hits.map(
				(hit) => hit.path,
			);

		expect(await paths([])).toContain("concepts/users.md");
		expect(await paths([])).toContain("search/title-match.md");

		expect(await paths(["--type", "BigQuery Table"])).toEqual([
			"concepts/users.md",
		]);
		expect(await paths(["--tag", "core"])).toEqual(["concepts/users.md"]);
		expect(await paths(["--dir", "concepts"])).toEqual(["concepts/users.md"]);
		expect(await paths(["--status", "stable"])).toEqual(["concepts/users.md"]);
		expect(await paths(["--trust", "human-reviewed"])).toEqual([
			"concepts/users.md",
		]);

		expect(
			(await paths(["--type", "Gauge"])).every((path) =>
				path.startsWith("search/"),
			),
		).toBe(true);

		// Composed filters are an AND: a Gauge is never in `concepts/`.
		expect(await paths(["--type", "Gauge", "--dir", "concepts"])).toEqual([]);
		expect(await paths(["--type", "Gauge", "--tag", "rank"])).toEqual(
			await paths(["--type", "Gauge"]),
		);
	});

	test("leaves a deprecated concept out until it is asked for", async () => {
		const home = await searchableHome();

		// `concepts/orders.md` is the only fixture with `status: deprecated`.
		expect((await search(home, ["purchases"])).hits).toEqual([]);

		expect(
			(await search(home, ["purchases", "--include-deprecated"])).hits.map(
				(hit) => hit.path,
			),
		).toEqual(["concepts/orders.md"]);

		expect(
			(await search(home, ["purchases", "--status", "deprecated"])).hits.map(
				(hit) => hit.path,
			),
		).toEqual(["concepts/orders.md"]);
	});

	test("ranks a concept past its staleness date below an equal fresh one", async () => {
		const home = await searchableHome();

		// The two widget fixtures are identical but for their `stale_after`:
		// 2030 and 2020. Judged from 2026, only the second is past it.
		const { hits } = await search(home, [
			"widget",
			"--as-of",
			"2026-01-01T00:00:00Z",
		]);

		expect(hits.map((hit) => hit.path)).toEqual([
			"search/fresh-widget.md",
			"search/stale-widget.md",
		]);
		expect(hits.map((hit) => hit.stale)).toEqual([false, true]);
		expect(hits[0].score).toBeGreaterThan(hits[1].score);

		// Judged from before both dates, neither is stale and the tie is broken
		// by path rather than by a penalty.
		const early = await search(home, [
			"widget",
			"--as-of",
			"2019-01-01T00:00:00Z",
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
		const [guide] = hits.filter((hit) => hit.path === "guides/chunking.md");
		const chunk = guide.chunks[0];

		const raw = readFileSync(
			join(home, "docs", "guides", "chunking.md"),
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
		expect(found.stdout).toContain("concepts/users.md — Users table");
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
