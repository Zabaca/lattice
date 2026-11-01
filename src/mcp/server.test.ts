import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../store/open.js";
import { changeNote } from "../store/store.js";
import {
	at,
	type Connected,
	cli,
	connect,
	freshHome,
	RERANKER_SECTIONS,
	storeHome,
} from "../store/testing.js";

/**
 * These drive the server the way an agent does: an MCP client over the real
 * protocol, on a home whose store `lattice import` built. The write tools do
 * not exist yet, so the few tests that need a note with a history make it
 * through the store module's own write primitive.
 */

const open: Connected[] = [];
afterEach(async () => {
	for (const session of open.splice(0)) {
		await session.close();
	}
});

async function session(
	home: string,
	options: Parameters<typeof connect>[1] = {},
): Promise<Connected> {
	const connected = await connect(home, options);
	open.push(connected);
	return connected;
}

describe("the tools", () => {
	test("the server offers the six reading tools, each described, each read-only", async () => {
		const home = await storeHome();
		const { client } = await session(home);

		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"history",
			"links",
			"list_notes",
			"read_note",
			"recall",
			"stats",
		]);
		for (const tool of tools) {
			expect(tool.description?.length).toBeGreaterThan(20);
			expect(tool.annotations?.readOnlyHint).toBe(true);
		}
	});

	test("the server tells an agent to ask first", async () => {
		const home = await storeHome();
		const { client } = await session(home);

		expect(client.getInstructions()).toContain("Ask first");
	});

	test("with no store the tools refuse and say how to build it", async () => {
		const { call } = await session(freshHome());

		const result = await call("stats");

		expect(result.isError).toBe(true);
		expect(result.body.next).toBe(
			"Run `lattice import` in a terminal to build it.",
		);
	});

	test("a server started before the store's layout changed refuses and says to restart the session", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		expect((await call("stats")).isError).toBe(false);

		const db = openStore(join(home, "store.db"));
		db.query("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
		db.close();

		const result = await call("stats");

		expect(result.isError).toBe(true);
		expect(result.body).toEqual({
			refused: "The store is now in layout 7; this server knows layout 6.",
			next: "Restart your session so it runs the current Lattice.",
		});
	});

	test("a store replaced under a running server is picked up on the next call", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		expect(at((await call("stats")).body, "notes", "total")).toBe(4);

		rmSync(join(home, "store.db"));
		rmSync(join(home, "store.db-wal"), { force: true });
		rmSync(join(home, "store.db-shm"), { force: true });
		await cli(home, ["import", "--no-library"]);

		expect(at((await call("stats")).body, "notes", "total")).toBe(4);
	});
});

describe("recall", () => {
	test("returns the passage that answers, with its note, section, heading and checked mark", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body, isError } = await call("recall", {
			question: "reciprocal rank fusion",
		});

		expect(isError).toBe(false);
		expect(at(body, "passages", 0)).toMatchObject({
			note: "research/jev-reranker",
			title: "Jev as a reranker",
			section: "s2",
			heading: "Key findings",
			checked: "unchecked",
		});
		expect(String(at(body, "passages", 0, "text"))).toContain(
			"Reciprocal rank fusion merges two rankings without trusting",
		);
	});

	test("says search ran in full, and how many passages lack a vector", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("recall", {
			question: "reciprocal rank fusion",
		});

		expect(body.search).toBe("full");
		expect(body.passages_without_vectors).toBe(0);
	});

	test("asked for notes, answers with the notes that cover the subject", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("recall", {
			question: "Exa exact phrase",
			best: "notes",
		});

		expect(body.passages).toBeUndefined();
		expect(at(body, "notes", 0)).toMatchObject({
			note: "research/exa-limits",
			title: "What Exa search is not good for",
			about: "Exa misses exact phrases.",
			checked: "0 of 1 sections",
		});
	});

	test("filters by type, by tag, and to named notes", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		const notesOf = (body: Record<string, unknown>) =>
			(body.passages as Array<{ note: string }>).map((p) => p.note);

		const topic = await call("recall", {
			question: "Jev",
			type: "Topic",
			limit: 10,
		});
		const tagged = await call("recall", {
			question: "Jev",
			tag: "search",
			limit: 10,
		});
		const within = await call("recall", {
			question: "Jev",
			notes: ["research/exa-limits"],
			limit: 10,
		});

		expect(new Set(notesOf(topic.body))).toEqual(new Set(["topic/jev"]));
		expect(new Set(notesOf(tagged.body))).toEqual(
			new Set(["research/jev-reranker"]),
		);
		expect(notesOf(within.body).every((n) => n === "research/exa-limits")).toBe(
			true,
		);
	});

	test("a passage reached through a link is marked as one", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("recall", {
			question: "typed answers with a probability",
		});

		const passages = body.passages as Array<{ note: string; via?: string }>;
		expect(passages[0].note).toBe("topic/jev");
		expect(passages.find((p) => p.via !== undefined)?.via).toMatch(
			/of topic\/jev$/,
		);
	});

	test("with no embedding model it still answers, on keywords, and says why", async () => {
		const home = await storeHome();
		const { call } = await session(home, {
			env: { LATTICE_EMBED_PROVIDER: "no-such-provider" },
		});

		const { body, isError } = await call("recall", {
			question: "reciprocal rank fusion",
		});

		expect(isError).toBe(false);
		expect(String(body.search)).toMatch(/^keyword-only: .*no-such-provider/);
		expect(at(body, "passages", 0, "note")).toBe("research/jev-reranker");
	});

	test("when a passage failed to embed the answer says how many lack a vector, and stats says why search is degraded", async () => {
		const home = await storeHome({
			env: { LATTICE_EMBED_FAIL: "permanent:exact quoted phrase" },
		});
		const { call } = await session(home);

		const asked = await call("recall", { question: "reciprocal rank fusion" });
		const stats = await call("stats");

		expect(asked.body.search).toBe("full");
		expect(asked.body.passages_without_vectors).toBe(1);
		expect(at(stats.body, "search", "ok")).toBe(false);
		expect(at(stats.body, "search", "failed")).toBe(1);
		expect(at(stats.body, "search", "problem")).toBe("1 embeddings failed");
	});

	test("an empty question is refused by the protocol, not answered", async () => {
		const home = await storeHome();
		const { client } = await session(home);

		const result = await client.callTool({
			name: "recall",
			arguments: { question: "" },
		});

		expect(result.isError).toBe(true);
	});

	test("each question is recorded with the client and project, and stats counts them", async () => {
		const home = await storeHome();
		const { call } = await session(home, { project: "/work/alpha" });
		const other = await session(home, { project: "/work/beta" });

		await call("recall", { question: "reciprocal rank fusion" });
		await other.call("recall", { question: "Exa exact phrase" });
		const { body } = await call("stats");

		expect(at(body, "questions", "last_7_days")).toBe(2);
		expect(at(body, "questions", "projects")).toBe(2);

		const rows = openStore(join(home, "store.db"))
			.query<{ project: string; client: string; question: string }, []>(
				"SELECT project, client, question FROM recall_log ORDER BY id",
			)
			.all();
		expect(rows).toEqual([
			{
				project: "/work/alpha",
				client: "test-client 1.2.3",
				question: "reciprocal rank fusion",
			},
			{
				project: "/work/beta",
				client: "test-client 1.2.3",
				question: "Exa exact phrase",
			},
		]);
	});
});

describe("two servers on one store", () => {
	test("both answer at once, and every question of both is recorded", async () => {
		const home = await storeHome();
		const first = await session(home, { project: "/work/alpha" });
		const second = await session(home, { project: "/work/beta" });
		const ask = (who: Connected) =>
			Promise.all(
				Array.from({ length: 5 }, (_, i) =>
					who.call("recall", { question: `reciprocal rank fusion ${i}` }),
				),
			);

		const answers = await Promise.all([ask(first), ask(second)]);

		expect(answers.flat().every((answer) => !answer.isError)).toBe(true);
		const stats = await first.call("stats");
		expect(at(stats.body, "questions", "last_7_days")).toBe(10);
		expect(at(stats.body, "questions", "projects")).toBe(2);
	});
});

describe("old notes from Lattice 1", () => {
	test("a note on the same subject written today ranks above the old one, and the old one says it is old", async () => {
		const home = await storeHome({ library: true });
		const { call } = await session(home);

		const { body } = await call("recall", {
			question: "reranker rereads the shortlist",
			best: "notes",
			limit: 10,
		});

		const notes = body.notes as Array<{
			note: string;
			old?: true;
			stale?: true;
		}>;
		const today = notes.findIndex((n) => n.note === "research/jev-reranker");
		const old = notes.findIndex((n) => n.note === "v1/jev/reranking");
		expect(today).toBeGreaterThanOrEqual(0);
		expect(old).toBeGreaterThanOrEqual(0);
		expect(today).toBeLessThan(old);
		expect(notes[old].old).toBe(true);
		expect(notes[old].stale).toBeUndefined();
		expect(notes[today].old).toBeUndefined();
	});

	test("a stub says its full text is lost", async () => {
		const home = await storeHome({ library: true });
		const { call } = await session(home);

		const { body } = await call("recall", {
			question: "Full text lost metadata survives",
		});

		const stub = (body.passages as Array<{ note: string }>).find(
			(p) => p.note === "v1/jev/gone",
		);
		expect(stub).toMatchObject({ old: true, full_text_lost: true });
	});

	test("the library's generated title list is archived: hidden unless asked for", async () => {
		const home = await storeHome({ library: true });
		const { call } = await session(home);

		const hidden = await call("recall", { question: "zzgenerated" });
		const shown = await call("recall", {
			question: "zzgenerated",
			include_archived: true,
		});

		expect(hidden.body.passages).toEqual([]);
		expect(at(shown.body, "passages", 0, "note")).toBe("v1/README");
	});
});

describe("read_note", () => {
	test("a short note comes whole, with its fields, version and an outline", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body, isError } = await call("read_note", {
			name: "research/jev-reranker",
		});

		expect(isError).toBe(false);
		expect(body).toMatchObject({
			name: "research/jev-reranker",
			title: "Jev as a reranker",
			type: "Research",
			version: 1,
			tags: ["jev", "search"],
			sources: ["../topic/jev.md", "https://example.com/jev"],
			sections: 3,
			checked: 0,
		});
		// The first section also holds the blank line the file left above its title.
		const [title, findings, cost] = RERANKER_SECTIONS.map((s) => s.length);
		expect(body.outline).toEqual([
			{
				id: "s1",
				heading: "Jev as a reranker",
				depth: 1,
				chars: title + 1,
				checked: "unchecked",
				version: 1,
			},
			{
				id: "s2",
				heading: "Key findings",
				depth: 2,
				chars: findings,
				checked: "unchecked",
				version: 1,
			},
			{
				id: "s3",
				heading: "Cost",
				depth: 2,
				chars: cost,
				checked: "unchecked",
				version: 1,
			},
		]);
		const text = (body.text as Array<{ text: string }>)
			.map((t) => t.text)
			.join("");
		expect(text).toBe(`\n${RERANKER_SECTIONS.join("")}`);
		expect(body.hint).toBeUndefined();
	});

	test("the note's other fields come back as written", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("read_note", { name: "topic/jev" });

		expect(body.fields).toEqual({
			generated: {
				by: "agent:claude-code/research",
				at: "2026-09-21T13:29:37Z",
			},
		});
	});

	test("a long note gives its outline and first section, and says how to ask for the rest", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("read_note", { name: "research/long-note" });

		expect(body.outline).toHaveLength(4);
		expect(body.text).toEqual([
			{ id: "s1", text: "\n# A long note\n\nOpening.\n\n" },
		]);
		expect(String(body.hint)).toContain('sections: ["s2", ...]');
	});

	test("sections asked for by id come back, and only those", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("read_note", {
			name: "research/long-note",
			sections: ["s3"],
		});

		expect(body.text).toHaveLength(1);
		expect(at(body, "text", 0, "id")).toBe("s3");
		expect(String(at(body, "text", 0, "text"))).toStartWith("## Two\n\n");
		expect(body.hint).toBeUndefined();
	});

	test("a section that is not there is refused with the ones that are", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const result = await call("read_note", {
			name: "topic/jev",
			sections: ["s9"],
		});

		expect(result.isError).toBe(true);
		expect(result.body).toEqual({
			refused: "topic/jev has no section s9.",
			next: "Its sections are s1, s2.",
		});
	});

	test("a name that is not a note is refused, with near names and where else to look", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const result = await call("read_note", { name: "research/jev" });

		expect(result.isError).toBe(true);
		expect(result.body.refused).toBe("There is no note named research/jev.");
		expect(String(result.body.next)).toContain("research/jev-reranker");
		expect(String(result.body.next)).toContain("recall");
	});

	test("a name written as a link writes it, with a suffix or a leading slash, still finds the note", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const withSuffix = await call("read_note", { name: "topic/jev.md" });
		const withSlash = await call("read_note", { name: "/topic/jev" });

		expect(withSuffix.body.name).toBe("topic/jev");
		expect(withSlash.body.name).toBe("topic/jev");
	});

	test("an old name after a rename leads to the note, and says which name was asked", async () => {
		const home = await storeHome();
		const db = openStore(join(home, "store.db"));
		db.query(
			`INSERT INTO note_names (name, concept_id)
			SELECT 'topic/typesafe-jev', id FROM concepts WHERE identifier = 'topic/jev'`,
		).run();
		db.close();
		const { call } = await session(home);

		const { body } = await call("read_note", { name: "topic/typesafe-jev" });

		expect(body.name).toBe("topic/jev");
		expect(body.answers_to).toBe("topic/typesafe-jev");
	});

	test("a note as it was at an earlier version", async () => {
		const home = await storeHome();
		const db = openStore(join(home, "store.db"));
		const id = db
			.query<{ id: number }, []>(
				"SELECT id FROM concepts WHERE identifier = 'research/exa-limits'",
			)
			.get()?.id;
		changeNote(db, id ?? 0, {
			kind: "edit",
			who: { client: "test" },
			sections: [
				{
					op: "update",
					sid: "s1",
					text: "\n# What Exa search is not good for\n\nChanged.\n",
				},
			],
		});
		db.close();
		const { call } = await session(home);

		const now = await call("read_note", { name: "research/exa-limits" });
		const before = await call("read_note", {
			name: "research/exa-limits",
			version: 1,
		});

		expect(now.body.version).toBe(2);
		expect(String(at(now.body, "text", 0, "text"))).toContain("Changed.");
		expect(before.body.version).toBe(1);
		expect(before.body.as_of_version).toBe(1);
		expect(String(at(before.body, "text", 0, "text"))).toContain(
			"cannot match an exact quoted phrase",
		);
	});

	test("a note from Lattice 1 says it is old, and a stub that its full text is lost", async () => {
		const home = await storeHome({ library: true });
		const { call } = await session(home);

		const old = await call("read_note", { name: "v1/jev/reranking" });
		const stub = await call("read_note", { name: "v1/jev/gone" });

		expect(old.body).toMatchObject({
			old: true,
			type: "Lattice 1",
			status: "archived",
		});
		expect(old.body.stale).toBeUndefined();
		expect(old.body.full_text_lost).toBeUndefined();
		expect(stub.body).toMatchObject({ old: true, full_text_lost: true });
	});
});

describe("list_notes", () => {
	test("lists notes by name with a title and the first line of the description, and pages", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const first = await call("list_notes", { limit: 2 });
		const second = await call("list_notes", { limit: 2, offset: 2 });

		expect(first.body.total).toBe(4);
		expect(first.body.next_offset).toBe(2);
		expect(first.body.notes).toEqual([
			{
				name: "research/exa-limits",
				title: "What Exa search is not good for",
				about: "Exa misses exact phrases.",
				version: 1,
				changed: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			},
			{
				name: "research/jev-reranker",
				title: "Jev as a reranker",
				about: "Where Jev fits in a search pipeline.",
				version: 1,
				changed: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			},
		]);
		expect(
			(second.body.notes as Array<{ name: string }>).map((n) => n.name),
		).toEqual(["research/long-note", "topic/jev"]);
		expect(second.body.next_offset).toBeUndefined();
	});

	test("filters by type and by tag", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		const names = (body: Record<string, unknown>) =>
			(body.notes as Array<{ name: string }>).map((n) => n.name);

		const topics = await call("list_notes", { type: "Topic" });
		const jev = await call("list_notes", { tag: "jev" });

		expect(names(topics.body)).toEqual(["topic/jev"]);
		expect(names(jev.body)).toEqual(["research/jev-reranker", "topic/jev"]);
	});

	test("leaves archived notes out unless asked for them", async () => {
		const home = await storeHome({ library: true });
		const { call } = await session(home);

		const hidden = await call("list_notes", { type: "Lattice 1", limit: 100 });
		const shown = await call("list_notes", {
			type: "Lattice 1",
			limit: 100,
			include_archived: true,
		});

		expect(hidden.body.total).toBe(4);
		expect(shown.body.total).toBe(5);
		const readme = (
			shown.body.notes as Array<{ name: string; archived?: true; old?: true }>
		).find((n) => n.name === "v1/README");
		expect(readme).toMatchObject({ archived: true, old: true });
	});
});

describe("links", () => {
	test("a note's links out, in with their sentences, and out to notes not yet written", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("links", { name: "topic/jev" });

		expect(body.out).toEqual([
			{
				to: "research/jev-reranker",
				title: "Jev as a reranker",
				kind: "markdown",
				text: "Jev as a reranker",
			},
		]);
		expect(body.in).toEqual([
			{
				from: "research/jev-reranker",
				title: "Jev as a reranker",
				kind: "source",
			},
			{
				from: "research/jev-reranker",
				title: "Jev as a reranker",
				kind: "wikilink",
				sentence: "See [[/topic/jev]] for the model itself.",
			},
		]);
		expect(body.unwritten).toEqual([
			{
				target: "research/jev-costs",
				sentence: "- [[/research/jev-costs]] has not been written.",
			},
		]);
	});

	test("a note that does not exist is refused", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const result = await call("links", { name: "topic/nothing" });

		expect(result.isError).toBe(true);
	});
});

describe("stats", () => {
	test("counts the notes, sections, changes and links wanted, and reports search health", async () => {
		const home = await storeHome({ library: true });
		const { call } = await session(home);

		const { body } = await call("stats");

		expect(body.notes).toEqual({
			total: 9,
			by_type: { "Lattice 1": 5, Research: 3, Topic: 1 },
			archived: 1,
			old: 5,
		});
		expect(at(body, "sections", "unchecked")).toBe(
			at(body, "sections", "total"),
		);
		expect(at(body, "changes", "last_7_days")).toBe(9);
		expect(at(body, "changes", "last", "kind")).toBe("import");
		expect(body.search).toMatchObject({
			ok: true,
			model: "hash-512",
			dim: 512,
			waiting: 0,
			failed: 0,
		});
		expect(body.wanted).toEqual([
			{ note: "research/jev-costs", wanted_by: 1 },
			{ note: "v1/jev/missing", wanted_by: 1 },
		]);
		expect(body.last_backup).toBeNull();
	});
});

describe("history", () => {
	test("lists the changes, newest first, with who made them; every imported note starts at an import change", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const { body } = await call("history", {});

		const changes = body.changes as Array<Record<string, unknown>>;
		expect(changes).toHaveLength(4);
		expect(changes[0]).toMatchObject({
			version: 1,
			kind: "import",
			who: { client: "lattice import" },
		});
		expect(String(changes[0].reason)).toMatch(
			/^imported from the bundle \(.*\.md\) on \d{4}-\d{2}-\d{2}$/,
		);
	});

	test("narrows to a note, to a client, and to changes since a date", async () => {
		const home = await storeHome();
		const db = openStore(join(home, "store.db"));
		const id = db
			.query<{ id: number }, []>(
				"SELECT id FROM concepts WHERE identifier = 'topic/jev'",
			)
			.get()?.id;
		changeNote(db, id ?? 0, {
			kind: "set_fields",
			reason: "tidy the title",
			who: {
				client: "claude-code 2.1.316",
				project: "/work/alpha",
				by: "reviewer",
			},
			at: "2099-01-01T00:00:00.000Z",
			fields: { title: "Jev, tidied" },
		});
		db.close();
		const { call } = await session(home);

		const byNote = await call("history", { note: "topic/jev" });
		const byWho = await call("history", { who: "reviewer" });
		const since = await call("history", { since: "2090-01-01" });

		expect((byNote.body.changes as unknown[]).length).toBe(2);
		expect(at(byWho.body, "changes", 0)).toMatchObject({
			note: "topic/jev",
			version: 2,
			kind: "set_fields",
			reason: "tidy the title",
			who: {
				client: "claude-code 2.1.316",
				project: "/work/alpha",
				by: "reviewer",
			},
		});
		expect((byWho.body.changes as unknown[]).length).toBe(1);
		expect((since.body.changes as unknown[]).length).toBe(1);
	});

	test("given a change id, the full before and after of what it touched", async () => {
		const home = await storeHome();
		const db = openStore(join(home, "store.db"));
		const id = db
			.query<{ id: number }, []>(
				"SELECT id FROM concepts WHERE identifier = 'research/exa-limits'",
			)
			.get()?.id;
		const made = changeNote(db, id ?? 0, {
			kind: "edit",
			who: {},
			sections: [
				{
					op: "update",
					sid: "s1",
					text: "\n# What Exa search is not good for\n\nNew.\n",
				},
			],
			fields: { status: "stable" },
		});
		db.close();
		const { call } = await session(home);

		const { body } = await call("history", { change: made.changeId });

		expect(body).toMatchObject({
			change: made.changeId,
			note: "research/exa-limits",
			version: 2,
			sections: [
				{
					id: "s1",
					op: "update",
					before:
						"\n# What Exa search is not good for\n\nExa neural search cannot match an exact quoted phrase.\n",
					after: "\n# What Exa search is not good for\n\nNew.\n",
				},
			],
			fields: [{ field: "status", before: null, after: "stable" }],
		});
	});

	test("an unknown change, an unknown note and a bad date are each refused with what to do", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		const change = await call("history", { change: 9999 });
		const note = await call("history", { note: "topic/nothing" });
		const since = await call("history", { since: "last tuesday" });

		expect(change.isError).toBe(true);
		expect(change.body.next).toContain("list changes");
		expect(note.isError).toBe(true);
		expect(since.isError).toBe(true);
		expect(since.body.next).toBe("Give since as a date such as 2026-11-01.");
	});
});
