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

/** Write a minimal OKF document into a home's bundle. */
function writeDoc(
	home: string,
	path: string,
	title: string,
	body: string,
	frontmatter: Record<string, string> = {},
): void {
	const fields = Object.entries({ type: "Note", title, ...frontmatter })
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	const file = join(home, "docs", path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `---\n${fields}\n---\n\n# ${title}\n\n${body}\n`);
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

describe("lattice search", () => {
	test("exits non-zero when the index does not exist", async () => {
		const result = await invoke(["search", "anything"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("No Lattice index");
		expect(result.stderr).toContain("lattice init");
	});

	test("finds the passage holding the query's words", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["search", "canonical account record"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("concepts/users.md");
		expect(result.stdout).toContain("The canonical account record.");
	});
	test("a natural-language question with punctuation and operator words still returns results", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(
			["search", 'What is the "canonical" account-record, and not the orders?'],
			home,
		);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("concepts/users.md");
	});

	test("finds an exact identifier written with punctuation", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["search", "user_id"], home);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("concepts/users.md");
		expect(result.stdout).toContain("`user_id` is the primary key.");
	});

	test("a query with no searchable words reports no results instead of failing", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["search", "?! -- ()"], home);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("No results");
	});

	test("a title match outranks a heading match, which outranks a body match", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		// Each section is padded past the chunker's merge threshold, so the
		// heading a match sits under is the heading it is indexed under.
		const filler =
			"Filler sentence that carries no query words at all. ".repeat(5);
		writeDoc(
			home,
			"body.md",
			"Something else",
			`${filler}\n\n## Other\n\nThe widget is mentioned here. ${filler}`,
		);
		writeDoc(
			home,
			"heading.md",
			"Something else again",
			`${filler}\n\n## Widget\n\nNothing to say. ${filler}`,
		);
		writeDoc(
			home,
			"title.md",
			"Widget",
			`${filler}\n\n## Other\n\nNothing to say. ${filler}`,
		);
		await invoke(["sync"], home);

		const result = await invoke(["search", "widget", "--json"], home);

		expect(result.code).toBe(0);
		expect(
			JSON.parse(result.stdout).map((hit: { path: string }) => hit.path),
		).toEqual(["title.md", "heading.md", "body.md"]);
	});

	test("groups hits by concept and caps the passages each one contributes", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		const filler =
			"Filler sentence that carries no query words at all. ".repeat(5);
		const sections = [1, 2, 3, 4]
			.map((n) => `## Section ${n}\n\nThe widget appears here too. ${filler}`)
			.join("\n\n");
		writeDoc(home, "many.md", "A long document", `${filler}\n\n${sections}`);
		writeDoc(
			home,
			"one.md",
			"A short document",
			`The widget appears once. ${filler}`,
		);
		await invoke(["sync"], home);

		const result = await invoke(["search", "widget", "--json"], home);
		const hits: Array<{ path: string; chunks: unknown[] }> = JSON.parse(
			result.stdout,
		);

		// Four of the long document's sections match; it is still one result
		// with two passages, so it cannot crowd the short document out.
		expect(hits.map((hit) => hit.path).sort()).toEqual(["many.md", "one.md"]);
		expect(hits.find((hit) => hit.path === "many.md")?.chunks).toHaveLength(2);

		const wider = await invoke(
			["search", "widget", "--json", "--chunks", "3"],
			home,
		);
		const widened: Array<{ path: string; chunks: unknown[] }> = JSON.parse(
			wider.stdout,
		);
		expect(widened.find((hit) => hit.path === "many.md")?.chunks).toHaveLength(
			3,
		);
	});

	test("filters by type, tag, directory, status and trust, and composes them", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const paths = async (argv: string[]) => {
			const result = await invoke(["search", ...argv, "--json"], home);
			expect(result.code).toBe(0);
			return (JSON.parse(result.stdout) as Array<{ path: string }>)
				.map((hit) => hit.path)
				.sort();
		};

		// "table" is in the title of both concepts and in no other document.
		expect(await paths(["table", "--include-deprecated"])).toEqual([
			"concepts/orders.md",
			"concepts/users.md",
		]);
		expect(await paths(["table", "--type", "BigQuery Table"])).toEqual([
			"concepts/users.md",
		]);
		expect(await paths(["chunker", "--tag", "guide"])).toEqual([
			"guides/chunking.md",
		]);
		expect(await paths(["table", "--dir", "concepts"])).toEqual([
			"concepts/users.md",
		]);
		expect(await paths(["table", "--status", "stable"])).toEqual([
			"concepts/users.md",
		]);
		expect(await paths(["table", "--trust", "human-reviewed"])).toEqual([
			"concepts/users.md",
		]);
		expect(await paths(["table", "--trust", "unverified"])).toEqual([]);

		// Composed: every filter must hold, so one that excludes wins.
		expect(
			await paths(["table", "--type", "BigQuery Table", "--tag", "core"]),
		).toEqual(["concepts/users.md"]);
		expect(
			await paths(["table", "--type", "BigQuery Table", "--tag", "guide"]),
		).toEqual([]);
	});

	test("leaves deprecated concepts out unless they are asked for", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const plain = await invoke(
			["search", "superseded purchases", "--json"],
			home,
		);
		expect(JSON.parse(plain.stdout)).toEqual([]);

		const included = await invoke(
			["search", "superseded purchases", "--json", "--include-deprecated"],
			home,
		);
		expect(
			(JSON.parse(included.stdout) as Array<{ path: string }>).map(
				(hit) => hit.path,
			),
		).toEqual(["concepts/orders.md"]);

		const byStatus = await invoke(
			["search", "superseded purchases", "--json", "--status", "deprecated"],
			home,
		);
		expect(
			(JSON.parse(byStatus.stdout) as Array<{ path: string }>).map(
				(hit) => hit.path,
			),
		).toEqual(["concepts/orders.md"]);
	});

	test("ranks a concept past its staleness date below an equivalent fresh one", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		const filler =
			"Filler sentence that carries no query words at all. ".repeat(5);
		const body = `The widget is described here. ${filler}`;
		writeDoc(home, "a-stale.md", "Stale widget notes", body, {
			stale_after: "2000-01-01T00:00:00Z",
		});
		writeDoc(home, "z-fresh.md", "Fresh widget notes", body, {
			stale_after: "2999-01-01T00:00:00Z",
		});
		await invoke(["sync"], home);

		const result = await invoke(["search", "widget", "--json"], home);
		const hits: Array<{ path: string; stale: boolean }> = JSON.parse(
			result.stdout,
		);

		expect(hits.map((hit) => hit.path)).toEqual(["z-fresh.md", "a-stale.md"]);
		expect(hits.map((hit) => hit.stale)).toEqual([false, true]);
	});

	test("machine-readable output carries the concept facts and passage offsets", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(["search", "primary key", "--json"], home);
		const [hit] = JSON.parse(result.stdout) as Array<{
			path: string;
			title: string;
			type: string;
			status: string;
			trust: string;
			stale: boolean;
			score: number;
			chunks: Array<{
				headingPath: string;
				ordinal: number;
				startLine: number;
				endLine: number;
				startChar: number;
				endChar: number;
				snippet: string;
			}>;
		}>;

		expect(hit.path).toBe("concepts/users.md");
		expect(hit.title).toBe("Users table");
		expect(hit.type).toBe("BigQuery Table");
		expect(hit.status).toBe("stable");
		expect(hit.trust).toBe("human-reviewed");
		expect(hit.stale).toBe(false);
		expect(typeof hit.score).toBe("number");

		const [chunk] = hit.chunks;
		// users.md is short enough that the chunker merges its sections, so the
		// passage is indexed under the document's own heading.
		expect(chunk.headingPath).toBe("Users table");
		expect(chunk.ordinal).toBeGreaterThanOrEqual(0);
		expect(chunk.snippet).toContain("`user_id` is the primary key.");

		// The offsets address the original file, frontmatter included, so an
		// editor opening them lands on the passage that matched.
		const file = readFileSync(join(home, "docs", hit.path), "utf8");
		expect(file.slice(chunk.startChar, chunk.endChar)).toContain(
			"`user_id` is the primary key.",
		);
		const lines = file.split("\n");
		expect(
			lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"),
		).toContain("`user_id` is the primary key.");
	});

	test("reports the nested heading path a passage sits under", async () => {
		const home = await bundledHome();
		await invoke(["sync"], home);

		const result = await invoke(
			["search", "fenced code block", "--json"],
			home,
		);
		const hits = JSON.parse(result.stdout) as Array<{
			path: string;
			chunks: Array<{ headingPath: string }>;
		}>;

		const guide = hits.find((hit) => hit.path === "guides/chunking.md");
		expect(guide?.chunks.map((chunk) => chunk.headingPath)).toContain(
			"Chunking guide > Fenced code",
		);
	});

	test("finds a concept whose title names the query even when its text never does", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		const filler =
			"Filler sentence that carries no query words at all. ".repeat(5);
		// The word "widget" appears only in the frontmatter title — the body and
		// every heading avoid it — so the FTS index over headings and content
		// cannot be the only place a title match is looked for.
		writeFileSync(
			join(home, "docs", "named.md"),
			`---\ntype: Note\ntitle: Widget internals\n---\n\n# Internals\n\n${filler}\n`,
		);
		await invoke(["sync"], home);

		const result = await invoke(["search", "widget", "--json"], home);
		const hits = JSON.parse(result.stdout) as Array<{
			path: string;
			title: string;
			chunks: Array<{ startChar: number; endChar: number }>;
		}>;

		expect(hits.map((hit) => hit.path)).toEqual(["named.md"]);
		expect(hits[0].title).toBe("Widget internals");
		expect(hits[0].chunks.length).toBeGreaterThan(0);
	});
});
