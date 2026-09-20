import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "./run.js";

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

describe("lattice sql", () => {
	test("returns rows as JSON and refuses a write without --write", async () => {
		const home = freshHome();
		await invoke(["init"], home);

		const read = await invoke(
			["sql", "SELECT count(*) AS n FROM concepts"],
			home,
		);
		expect(read.code).toBe(0);
		expect(JSON.parse(read.stdout)).toEqual([{ n: 0 }]);

		const write = await invoke(["sql", "DELETE FROM concepts"], home);
		expect(write.code).not.toBe(0);
		expect(write.stderr).toContain("--write");

		// A write smuggled in behind a read is still a write.
		const smuggled = await invoke(
			["sql", "SELECT 1; DELETE FROM concepts"],
			home,
		);
		expect(smuggled.code).not.toBe(0);
		expect(smuggled.stderr).toContain("--write");
	});
});

/** Write one bundle file, creating its directories. */
function writeDoc(home: string, relativePath: string, body: string): void {
	const file = join(home, "docs", relativePath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
}

async function sqlRows(
	home: string,
	query: string,
): Promise<Array<Record<string, unknown>>> {
	const result = await invoke(["sql", query], home);
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout);
}

describe("lattice sync", () => {
	test("indexes every non-reserved markdown file by its bundle-relative path", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(
			home,
			"orders.md",
			"---\ntype: BigQuery Table\ntitle: Orders\n---\n\n# Orders\n\nOne order per row.\n",
		);
		writeDoc(home, "sales/revenue.md", "---\ntype: Metric\n---\n\nRevenue.\n");
		writeDoc(home, "index.md", "# Bundle\n");
		writeDoc(home, "sales/log.md", "# Changes\n");

		const result = await invoke(["sync"], home);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("2 new");

		const rows = await sqlRows(
			home,
			"SELECT path, title, type FROM concepts ORDER BY path",
		);
		expect(rows).toEqual([
			{ path: "orders.md", title: "Orders", type: "BigQuery Table" },
			{ path: "sales/revenue.md", title: "revenue", type: "Metric" },
		]);
	});

	test("promotes filter fields, records tags, and derives the OKF trust tiers", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(
			home,
			"none.md",
			"---\ntype: Playbook\nstatus: deprecated\nstale_after: 2026-09-23T00:00:00Z\ntags: [sales, orders]\nresource: https://example.test/x\n---\n\nBody.\n",
		);
		writeDoc(
			home,
			"human.md",
			"---\ntype: Playbook\nverified:\n  - { by: 'human:ahormati', at: 2026-06-25T09:00:00Z }\n  - { by: 'process:finance-nightly', at: 2026-06-26T02:00:00Z }\n---\n\nBody.\n",
		);
		writeDoc(
			home,
			"machine.md",
			"---\ntype: Playbook\nverified: { by: 'process:finance-nightly', at: 2026-06-26T02:00:00Z }\n---\n\nBody.\n",
		);

		await invoke(["sync"], home);

		const rows = await sqlRows(
			home,
			"SELECT path, status, stale_after, trust_level FROM concepts ORDER BY path",
		);
		expect(rows).toEqual([
			{
				path: "human.md",
				status: "stable",
				stale_after: null,
				trust_level: "human-reviewed",
			},
			{
				path: "machine.md",
				status: "stable",
				stale_after: null,
				trust_level: "machine-confirmed",
			},
			{
				path: "none.md",
				status: "deprecated",
				stale_after: "2026-09-23T00:00:00Z",
				trust_level: "unverified",
			},
		]);

		const tags = await sqlRows(
			home,
			"SELECT tag FROM concept_tags JOIN concepts ON concepts.id = concept_tags.concept_id WHERE concepts.path = 'none.md' ORDER BY tag",
		);
		expect(tags).toEqual([{ tag: "orders" }, { tag: "sales" }]);

		const [preserved] = await sqlRows(
			home,
			"SELECT json_extract(frontmatter, '$.resource') AS resource FROM concepts WHERE path = 'none.md'",
		);
		expect(preserved).toEqual({ resource: "https://example.test/x" });
	});

	test("splits at headings and records heading paths and file offsets", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		// Line numbers are counted by hand from this literal: the frontmatter
		// occupies lines 1-4, `# Deploy` is line 6, `## Rollback` is line 10,
		// and the closing code fence is line 16.
		const file = [
			"---",
			"type: Playbook",
			"title: Deploy",
			"---",
			"",
			"# Deploy",
			"",
			"The deploy playbook explains how this service is released, and who to call when it goes wrong. Read it before you start.",
			"",
			"## Rollback",
			"",
			"Run the rollback script, then tell the on-call engineer what you did and why the release had to go back.",
			"",
			"```sh",
			"rollback --now",
			"```",
			"",
		].join("\n");
		writeDoc(home, "deploy.md", file);

		await invoke(["sync"], home);

		const rows = await sqlRows(
			home,
			"SELECT ordinal, heading, heading_path, start_line, end_line, start_char FROM chunks ORDER BY ordinal",
		);
		expect(rows).toEqual([
			{
				ordinal: 0,
				heading: "Deploy",
				heading_path: "Deploy",
				start_line: 6,
				end_line: 8,
				start_char: file.indexOf("# Deploy"),
			},
			{
				ordinal: 1,
				heading: "Rollback",
				heading_path: "Deploy > Rollback",
				start_line: 10,
				end_line: 16,
				start_char: file.indexOf("## Rollback"),
			},
		]);

		// The offsets have to address the original file: slicing it with them
		// must reproduce each passage exactly.
		const spans = await sqlRows(
			home,
			"SELECT start_char, end_char FROM chunks ORDER BY ordinal",
		);
		expect(
			file.slice(Number(spans[0].start_char), Number(spans[0].end_char)),
		).toBe(
			"# Deploy\n\nThe deploy playbook explains how this service is released, and who to call when it goes wrong. Read it before you start.",
		);
		expect(
			file.slice(Number(spans[1].start_char), Number(spans[1].end_char)),
		).toBe(
			"## Rollback\n\nRun the rollback script, then tell the on-call engineer what you did and why the release had to go back.\n\n```sh\nrollback --now\n```",
		);

		const [second] = await sqlRows(
			home,
			"SELECT content FROM chunks WHERE ordinal = 1",
		);
		expect(second.content).toContain("Deploy > Rollback");
		expect(second.content).toContain("rollback --now");
	});

	test("merges a section too short to stand alone into the next one", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		// `# Short` is line 6 and the last line of prose is line 12.
		const file = [
			"---",
			"type: Note",
			"title: Short",
			"---",
			"",
			"# Short",
			"",
			"Tiny.",
			"",
			"## Long",
			"",
			"This section is long enough to stand on its own, which is exactly why the two-word section above it has nowhere to go but here.",
			"",
		].join("\n");
		writeDoc(home, "short.md", file);

		await invoke(["sync"], home);

		const rows = await sqlRows(
			home,
			"SELECT ordinal, heading, start_line, end_line FROM chunks ORDER BY ordinal",
		);
		expect(rows).toEqual([
			{ ordinal: 0, heading: "Short", start_line: 6, end_line: 12 },
		]);
	});

	test("splits an oversize section at paragraphs with overlap, and never splits a fence", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		// Six paragraphs of 300 characters is 1,800 — past the 1,600-character
		// (~400 token) cap — so this section has to be split.
		const paragraphs = [1, 2, 3, 4, 5, 6].map((n) =>
			`PARA${n} ${"filler word ".repeat(24)}`.slice(0, 300),
		);
		writeDoc(
			home,
			"long.md",
			`---\ntype: Note\ntitle: Long\n---\n\n# Long\n\n${paragraphs.join("\n\n")}\n`,
		);
		writeDoc(
			home,
			"fenced.md",
			[
				"---",
				"type: Note",
				"title: Fenced",
				"---",
				"",
				"# Fenced",
				"",
				`Prose that pushes this section past the cap. ${"more prose ".repeat(140)}`,
				"",
				"```sh",
				"FENCE_START",
				`# ${"a long line of shell ".repeat(40)}`,
				"FENCE_END",
				"```",
				"",
			].join("\n"),
		);

		await invoke(["sync"], home);

		const pieces = await sqlRows(
			home,
			"SELECT content FROM chunks JOIN concepts ON concepts.id = chunks.concept_id WHERE concepts.path = 'long.md' ORDER BY ordinal",
		);
		expect(pieces.length).toBe(2);
		// The last paragraph of the first piece opens the second one.
		expect(pieces[0].content).toContain("PARA5");
		expect(pieces[1].content).toContain("PARA5");
		expect(pieces[1].content).toContain("PARA6");
		expect(pieces[0].content).not.toContain("PARA6");

		const fenced = await sqlRows(
			home,
			"SELECT content FROM chunks JOIN concepts ON concepts.id = chunks.concept_id WHERE concepts.path = 'fenced.md' ORDER BY ordinal",
		);
		expect(fenced.length).toBeGreaterThan(1);
		const withFence = fenced.filter((row) =>
			String(row.content).includes("FENCE_START"),
		);
		expect(withFence.length).toBe(1);
		expect(withFence[0].content).toContain("FENCE_END");
	});

	test("does no work on an unchanged second run and re-indexes only what changed", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(
			home,
			"a.md",
			"---\ntype: Note\n---\n\n# A\n\nThe first document, left alone.\n",
		);
		writeDoc(
			home,
			"b.md",
			"---\ntype: Note\n---\n\n# B\n\nThe second document, edited below.\n",
		);

		await invoke(["sync"], home);
		const before = await sqlRows(
			home,
			"SELECT path, indexed_at, content_hash FROM concepts ORDER BY path",
		);

		const second = await invoke(["sync"], home);
		expect(second.stdout).toContain("0 new, 0 changed, 0 deleted");
		expect(
			await sqlRows(
				home,
				"SELECT path, indexed_at, content_hash FROM concepts ORDER BY path",
			),
		).toEqual(before);

		writeDoc(
			home,
			"b.md",
			"---\ntype: Note\n---\n\n# B\n\nRewritten entirely.\n",
		);
		const third = await invoke(["sync"], home);
		expect(third.stdout).toContain("0 new, 1 changed, 0 deleted");

		const after = await sqlRows(
			home,
			"SELECT path, indexed_at, content_hash FROM concepts ORDER BY path",
		);
		expect(after[0]).toEqual(before[0] as unknown as Record<string, unknown>);
		expect(after[1].content_hash).not.toBe(before[1].content_hash);
	});

	test("deleting a file removes its concept, chunks and tags", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(
			home,
			"gone.md",
			"---\ntype: Note\ntags: [doomed]\n---\n\n# Gone\n\nThis document is about to be deleted.\n",
		);
		await invoke(["sync"], home);
		expect(
			(await sqlRows(home, "SELECT count(*) AS n FROM chunks"))[0].n,
		).toBeGreaterThan(0);

		rmSync(join(home, "docs", "gone.md"));
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("0 new, 0 changed, 1 deleted");
		expect(await sqlRows(home, "SELECT count(*) AS n FROM concepts")).toEqual([
			{ n: 0 },
		]);
		expect(await sqlRows(home, "SELECT count(*) AS n FROM chunks")).toEqual([
			{ n: 0 },
		]);
		expect(
			await sqlRows(home, "SELECT count(*) AS n FROM concept_tags"),
		).toEqual([{ n: 0 }]);
	});

	test("renaming a file with unchanged content keeps the concept's identity", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		const body =
			"---\ntype: Note\n---\n\n# Named\n\nThe content does not change, only the filename does.\n";
		writeDoc(home, "before.md", body);
		await invoke(["sync"], home);
		const [original] = await sqlRows(home, "SELECT id FROM concepts");

		rmSync(join(home, "docs", "before.md"));
		writeDoc(home, "topic/after.md", body);
		const result = await invoke(["sync"], home);

		expect(result.stdout).toContain("1 renamed");
		expect(
			await sqlRows(home, "SELECT id, path, directory FROM concepts"),
		).toEqual([
			{ id: original.id, path: "topic/after.md", directory: "topic" },
		]);
	});

	test("refuses while a live sync holds the lock and takes over a dead one", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(home, "a.md", "---\ntype: Note\n---\n\n# A\n\nA document.\n");
		const lock = join(home, ".sync.lock");

		writeFileSync(lock, `${process.pid}\n`);
		const refused = await invoke(["sync"], home);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("Another sync is already running");
		expect(await sqlRows(home, "SELECT count(*) AS n FROM concepts")).toEqual([
			{ n: 0 },
		]);

		// A pid that cannot be running: the kernel reserves 0 for the swapper
		// and never hands it to a user process.
		writeFileSync(lock, "0\n");
		const stale = await invoke(["sync"], home);
		expect(stale.code).toBe(0);
		expect(await sqlRows(home, "SELECT count(*) AS n FROM concepts")).toEqual([
			{ n: 1 },
		]);
		expect(existsSync(lock)).toBe(false);
	});

	test("status counts what a sync would do before it runs", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(
			home,
			"kept.md",
			"---\ntype: Note\n---\n\n# Kept\n\nUnchanged throughout.\n",
		);
		writeDoc(
			home,
			"edited.md",
			"---\ntype: Note\n---\n\n# Edited\n\nBefore the edit.\n",
		);
		writeDoc(
			home,
			"removed.md",
			"---\ntype: Note\n---\n\n# Removed\n\nSoon to go.\n",
		);
		await invoke(["sync"], home);

		writeDoc(
			home,
			"edited.md",
			"---\ntype: Note\n---\n\n# Edited\n\nAfter the edit.\n",
		);
		rmSync(join(home, "docs", "removed.md"));
		writeDoc(
			home,
			"added.md",
			"---\ntype: Note\n---\n\n# Added\n\nBrand new.\n",
		);

		const result = await invoke(["status"], home);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("1 new");
		expect(result.stdout).toContain("1 changed");
		expect(result.stdout).toContain("1 deleted");
	});

	test("resumes after a sync that only got through part of the bundle", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(
			home,
			"one.md",
			"---\ntype: Note\n---\n\n# One\n\nThe first document.\n",
		);
		writeDoc(
			home,
			"two.md",
			"---\ntype: Note\n---\n\n# Two\n\nThe second document.\n",
		);
		await invoke(["sync"], home);

		// An interruption can only land between documents, because each one is
		// its own transaction. That state is exactly one concept short.
		const dropped = await invoke(
			["sql", "DELETE FROM concepts WHERE path = 'two.md'", "--write"],
			home,
		);
		expect(dropped.code).toBe(0);

		const resumed = await invoke(["sync"], home);

		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toContain("1 new, 0 changed, 0 deleted");
		expect(
			await sqlRows(home, "SELECT path FROM concepts ORDER BY path"),
		).toEqual([{ path: "one.md" }, { path: "two.md" }]);
	});

	test("indexes a document with missing or invalid frontmatter and reports it", async () => {
		const home = freshHome();
		await invoke(["init"], home);
		writeDoc(home, "bare.md", "# Bare\n\nNo frontmatter at all.\n");
		writeDoc(home, "broken.md", "---\ntype: [unclosed\n---\n\nBody.\n");

		const sync = await invoke(["sync"], home);
		expect(sync.code).toBe(0);

		const rows = await sqlRows(
			home,
			"SELECT path, type FROM concepts ORDER BY path",
		);
		expect(rows).toEqual([
			{ path: "bare.md", type: null },
			{ path: "broken.md", type: null },
		]);

		const status = await invoke(["status"], home);
		expect(status.code).toBe(0);
		expect(status.stdout).toContain("bare.md");
		expect(status.stdout).toContain("broken.md");
	});
});
