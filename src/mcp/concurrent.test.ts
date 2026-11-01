import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openStore } from "../store/open.js";
import { at, type Body, storeHome } from "../store/testing.js";

/**
 * Many sessions on one Mac share one store, each through a server process of
 * its own. These start real `lattice mcp` processes on one home and have them
 * write at the same time, because the guards (a quote that occurs once, a
 * section still at the version read, an undo refused after a later change to
 * the same section) are decided inside SQLite's write lock, and only separate
 * processes show that they hold.
 */

const MAIN = join(import.meta.dir, "..", "main.ts");

interface Process {
	call(name: string, args?: Record<string, unknown>): Promise<Result>;
	close(): Promise<void>;
}
interface Result {
	isError: boolean;
	body: Body;
}

const running: Process[] = [];
afterEach(async () => {
	for (const proc of running.splice(0)) {
		await proc.close();
	}
});

async function start(home: string, name: string): Promise<Process> {
	const client = new Client({ name, version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [MAIN, "mcp"],
		cwd: home,
		env: { LATTICE_HOME: home, LATTICE_EMBED_PROVIDER: "hash" },
		stderr: "pipe",
	});
	await client.connect(transport);
	const proc: Process = {
		async call(tool, args = {}) {
			const result = await client.callTool({ name: tool, arguments: args });
			const content = result.content as Array<{ text: string }>;
			return {
				isError: result.isError === true,
				body: JSON.parse(content[0].text),
			};
		},
		close: () => client.close(),
	};
	running.push(proc);
	return proc;
}

async function fleet(home: string, count: number): Promise<Process[]> {
	return Promise.all(
		Array.from({ length: count }, (_, i) => start(home, `session-${i + 1}`)),
	);
}

function textOf(body: Body): string {
	return (body.text as Array<{ text: string }>).map((t) => t.text).join("");
}

/** The store as a person would check it afterwards: whole, and with a change per version. */
function checkStore(home: string, note: string, versions: number) {
	const db = openStore(join(home, "store.db"));
	try {
		expect(
			db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
				?.integrity_check,
		).toBe("ok");
		const rows = db
			.query<{ version: number }, [string]>(
				`SELECT ch.version FROM changes ch JOIN concepts c ON c.id = ch.concept_id
				WHERE c.identifier = ? ORDER BY ch.version`,
			)
			.all(note)
			.map((row) => row.version);
		expect(rows).toEqual(Array.from({ length: versions }, (_, i) => i + 1));
		expect(
			db
				.query<{ version: number }, [string]>(
					"SELECT version FROM concepts WHERE identifier = ?",
				)
				.get(note)?.version,
		).toBe(versions);
	} finally {
		db.close();
	}
}

describe("sessions writing at once", () => {
	test("two edits to different passages of one note both land, in a history that shows both in order", async () => {
		const home = await storeHome();
		const [one, two] = await fleet(home, 2);

		const [a, b] = await Promise.all([
			one.call("edit", {
				note: "research/jev-reranker",
				edits: [
					{
						old: "Jev then rereads the shortlist",
						new: "Jev then rereads the top twenty",
					},
				],
				reason: "from one",
			}),
			two.call("edit", {
				note: "research/jev-reranker",
				edits: [
					{
						old: "a fraction of a cent",
						new: "under a cent",
					},
				],
				reason: "from two",
			}),
		]);

		expect(a.isError).toBe(false);
		expect(b.isError).toBe(false);
		const note = (
			await one.call("read_note", { name: "research/jev-reranker" })
		).body;
		expect(textOf(note)).toContain("Jev then rereads the top twenty");
		expect(textOf(note)).toContain("under a cent");
		expect(note.version).toBe(3);
		const log = await two.call("history", { note: "research/jev-reranker" });
		const kinds = (
			log.body.changes as Array<{
				version: number;
				reason?: string;
				who: { client: string };
			}>
		).slice(0, 2);
		expect(kinds.map((c) => c.version)).toEqual([3, 2]);
		expect(new Set(kinds.map((c) => c.reason))).toEqual(
			new Set(["from one", "from two"]),
		);
		expect(new Set(kinds.map((c) => c.who.client))).toEqual(
			new Set(["session-1 1.0.0", "session-2 1.0.0"]),
		);
		checkStore(home, "research/jev-reranker", 3);
	}, 30_000);

	test("two edits quoting the same passage: one lands, the other is refused and the first stands", async () => {
		const home = await storeHome();
		const [one, two] = await fleet(home, 2);
		const edit = (to: string) => ({
			note: "research/jev-reranker",
			edits: [{ old: "a fraction of a cent", new: to }],
		});

		const [a, b] = await Promise.all([
			one.call("edit", edit("one cent")),
			two.call("edit", edit("two cents")),
		]);

		const landed = [a, b].filter((r) => !r.isError);
		const refused = [a, b].filter((r) => r.isError);
		expect(landed).toHaveLength(1);
		expect(refused).toHaveLength(1);
		expect(refused[0].body.refused).toBe(
			"That passage is not in the note. It may have changed since you read it.",
		);
		expect(refused[0].body.next).toBe(
			"Read the note again (read_note) and quote what it says now.",
		);
		const text = textOf(
			(await one.call("read_note", { name: "research/jev-reranker" })).body,
		);
		expect(text).toContain(a.isError ? "two cents" : "one cent");
		expect(text).not.toContain(a.isError ? "one cent" : "two cents");
		checkStore(home, "research/jev-reranker", 2);
	}, 30_000);

	test("two whole-section replacements of the version both read: one lands, the other is told the section changed", async () => {
		const home = await storeHome();
		const [one, two] = await fleet(home, 2);
		const replace = (text: string) => ({
			note: "research/jev-reranker",
			edits: [
				{ section: "s2", text: `## Key findings\n\n${text}\n`, version: 1 },
			],
		});

		const [a, b] = await Promise.all([
			one.call("edit", replace("Fusion is rank based.")),
			two.call("edit", replace("Fusion is score based.")),
		]);

		expect([a, b].filter((r) => !r.isError)).toHaveLength(1);
		const refused = [a, b].find((r) => r.isError);
		expect(String(refused?.body.refused)).toContain(
			"s2 is at version 2; you read version 1. It changed since you read it.",
		);
		checkStore(home, "research/jev-reranker", 2);
	}, 30_000);

	test("four sessions each appending five findings to one section: all twenty land, none lost", async () => {
		const home = await storeHome();
		const sessions = await fleet(home, 4);

		const results = await Promise.all(
			sessions.map(async (session, who) => {
				const out: Result[] = [];
				for (let n = 1; n <= 5; n++) {
					out.push(
						await session.call("append", {
							note: "research/exa-limits",
							text: `- finding ${who + 1}.${n}`,
						}),
					);
				}
				return out;
			}),
		);

		expect(results.flat().filter((r) => r.isError)).toEqual([]);
		const note = (
			await sessions[0].call("read_note", { name: "research/exa-limits" })
		).body;
		const text = textOf(note);
		for (let who = 1; who <= 4; who++) {
			for (let n = 1; n <= 5; n++) {
				expect(text).toContain(`- finding ${who}.${n}\n`);
			}
		}
		// Each session's own findings are in the order it wrote them.
		for (let who = 1; who <= 4; who++) {
			const places = [1, 2, 3, 4, 5].map((n) =>
				text.indexOf(`- finding ${who}.${n}\n`),
			);
			expect(places).toEqual([...places].sort((x, y) => x - y));
		}
		expect(note.version).toBe(21);
		checkStore(home, "research/exa-limits", 21);
		// The passages were rebuilt on every write and none is missing a vector.
		const stats = await sessions[1].call("stats");
		expect(at(stats.body, "search", "waiting")).toBe(0);
	}, 60_000);

	test("two sessions creating the same note: one makes it, the other is told it exists", async () => {
		const home = await storeHome();
		const [one, two] = await fleet(home, 2);
		const make = (text: string) => ({ type: "Research", title: "Race", text });

		const [a, b] = await Promise.all([
			one.call("create_note", make("From one.")),
			two.call("create_note", make("From two.")),
		]);

		expect([a, b].filter((r) => !r.isError)).toHaveLength(1);
		expect(String([a, b].find((r) => r.isError)?.body.refused)).toBe(
			"A note named research/race already exists (Race).",
		);
		checkStore(home, "research/race", 1);
	}, 30_000);

	test("an undo is refused when another session has since changed the same section, and allowed when it changed another", async () => {
		const home = await storeHome();
		const [one, two] = await fleet(home, 2);
		const first = await one.call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "a fraction of a cent", new: "a tenth of a cent" }],
		});
		const other = await two.call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "Jev then rereads the shortlist",
					new: "Jev then rereads a shortlist",
				},
			],
		});
		expect(other.isError).toBe(false);

		// Session two changed a different section, so session one may undo its own change.
		const allowed = await one.call("revert", {
			change: Number(first.body.change),
		});
		expect(allowed.isError).toBe(false);

		const again = await one.call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "a fraction of a cent", new: "a hundredth of a cent" }],
		});
		const later = await two.call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "for a whole shortlist", new: "for the whole shortlist" }],
		});
		expect(later.isError).toBe(false);

		const refused = await one.call("revert", {
			change: Number(again.body.change),
		});
		expect(refused.isError).toBe(true);
		expect(refused.body.refused).toBe(
			`Change ${later.body.change} (edit, by session-2 1.0.0, ${new Date().toISOString().slice(0, 10)}) also changed section s3, after change ${again.body.change}.`,
		);
		checkStore(home, "research/jev-reranker", 6);
	}, 30_000);

	test("while one session writes, others keep reading and asking", async () => {
		const home = await storeHome();
		const [writer, reader] = await fleet(home, 2);

		const writes = (async () => {
			for (let n = 1; n <= 8; n++) {
				const out = await writer.call("append", {
					note: "research/exa-limits",
					text: `- note ${n}`,
				});
				expect(out.isError).toBe(false);
			}
		})();
		const reads = (async () => {
			for (let n = 0; n < 8; n++) {
				const asked = await reader.call("recall", {
					question: "Exa exact phrase",
				});
				expect(asked.isError).toBe(false);
				expect(at(asked.body, "passages", 0, "note")).toBe(
					"research/exa-limits",
				);
				const note = await reader.call("read_note", {
					name: "research/exa-limits",
				});
				expect(note.isError).toBe(false);
			}
		})();
		await Promise.all([writes, reads]);

		checkStore(home, "research/exa-limits", 9);
	}, 60_000);
});
