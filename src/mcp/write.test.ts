import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openStore } from "../store/open.js";
import {
	at,
	type Body,
	type Connected,
	connect,
	HASH_ENV,
	storeHome,
} from "../store/testing.js";
import { createLatticeServer } from "./server.js";

/**
 * The writing tools, driven the way an agent drives them: an MCP client over
 * the real protocol, on a home whose store `lattice import` built from the
 * fixture bundle (testing.ts). Expected values are literals from that fixture.
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

async function fresh(options: Parameters<typeof connect>[1] = {}) {
	const home = await storeHome();
	return { home, ...(await session(home, options)) };
}

/** A note as `read_note` gives it, whole. */
async function read(
	call: Connected["call"],
	name: string,
	extra: Record<string, unknown> = {},
) {
	const { body, isError } = await call("read_note", { name, ...extra });
	expect(isError).toBe(false);
	return body;
}

function textOf(body: Body): string {
	return (body.text as Array<{ text: string }>).map((t) => t.text).join("");
}

function outlineOf(body: Body): Array<[string, number, string]> {
	return (
		body.outline as Array<{ id: string; version: number; checked: string }>
	).map((s) => [s.id, s.version, s.checked]);
}

describe("create_note", () => {
	test("makes a note named from its type and title, found by the next question, with the change attributed", async () => {
		const { call } = await fresh({ project: "/work/alpha" });

		const made = await call("create_note", {
			type: "Research",
			title: "Quasar Catalog Basics",
			description: "What the quasar catalog holds.",
			text: "Quasars are listed with redshift and magnitude.",
			tags: ["astronomy"],
			sources: ["https://example.com/quasars", "research/jev-reranker"],
			reason: "first look",
			by: "stargazer",
		});

		expect(made.isError).toBe(false);
		expect(made.body).toMatchObject({
			note: "research/quasar-catalog-basics",
			version: 1,
			sections: [{ id: "s1", version: 1 }],
		});
		const note = await read(call, "research/quasar-catalog-basics");
		expect(note).toMatchObject({
			title: "Quasar Catalog Basics",
			type: "Research",
			status: "draft",
			tags: ["astronomy"],
			// A note named as a source is written the relative way other notes do.
			sources: ["https://example.com/quasars", "jev-reranker.md"],
			checked: 0,
		});
		expect(textOf(note)).toBe(
			"# Quasar Catalog Basics\n\nQuasars are listed with redshift and magnitude.\n",
		);

		const found = await call("recall", {
			question: "quasar redshift magnitude",
		});
		expect(at(found.body, "passages", 0, "note")).toBe(
			"research/quasar-catalog-basics",
		);
		expect(found.body.passages_without_vectors).toBe(0);

		const changes = await call("history", {
			note: "research/quasar-catalog-basics",
		});
		expect(at(changes.body, "changes", 0)).toMatchObject({
			version: 1,
			kind: "create",
			reason: "first look",
			who: {
				client: "test-client 1.2.3",
				project: "/work/alpha",
				by: "stargazer",
			},
		});
	});

	test("a title that makes the name of an existing note is refused with that note's name", async () => {
		const { call } = await fresh();

		const again = await call("create_note", {
			type: "Research",
			title: "Exa limits",
		});

		expect(again.isError).toBe(true);
		expect(again.body).toEqual({
			refused:
				"A note named research/exa-limits already exists (What Exa search is not good for).",
			next: "Extend it instead: read_note research/exa-limits, then edit or append. For a different note, use a different title.",
		});
	});

	test("a note with no text is its title line alone", async () => {
		const { call } = await fresh();

		await call("create_note", { type: "Topic", title: "Pulsars" });

		const note = await read(call, "topic/pulsars");
		expect(textOf(note)).toBe("# Pulsars\n");
		expect(note.sections).toBe(1);
	});
});

describe("edit", () => {
	test("replaces a quoted passage and nothing else, raising only that section's version", async () => {
		const { call } = await fresh();

		const done = await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "A reranker call costs a fraction of a cent",
					new: "A reranker call costs well under a cent",
				},
			],
			reason: "tighter",
		});

		expect(done.isError).toBe(false);
		expect(done.body).toMatchObject({
			note: "research/jev-reranker",
			version: 2,
			sections: [{ id: "s3", version: 2 }],
		});
		const note = await read(call, "research/jev-reranker");
		expect(textOf(note)).toContain(
			"costs well under a cent for a whole shortlist",
		);
		expect(textOf(note)).not.toContain("fraction of a cent");
		expect(outlineOf(note)).toEqual([
			["s1", 1, "unchecked"],
			["s2", 1, "unchecked"],
			["s3", 2, "unchecked"],
		]);

		// The history keeps what it replaced.
		const detail = await call("history", { change: Number(done.body.change) });
		expect(at(detail.body, "sections", 0)).toMatchObject({
			id: "s3",
			op: "update",
		});
		expect(String(at(detail.body, "sections", 0, "before"))).toContain(
			"fraction of a cent",
		);
		expect(String(at(detail.body, "sections", 0, "after"))).toContain(
			"well under a cent",
		);
	});

	test("the edit is searchable at once, and the old wording is no longer found", async () => {
		const { call } = await fresh();

		await call("edit", {
			note: "research/exa-limits",
			edits: [
				{
					old: "cannot match an exact quoted phrase",
					new: "misses trigram lookups entirely",
				},
			],
		});

		const found = await call("recall", { question: "trigram lookups" });
		expect(at(found.body, "passages", 0, "note")).toBe("research/exa-limits");
		expect(found.body.passages_without_vectors).toBe(0);
		const gone = await call("recall", {
			question: "quoted phrase",
			notes: ["research/exa-limits"],
		});
		expect(String(at(gone.body, "passages", 0, "text"))).not.toContain(
			"exact quoted phrase",
		);
	});

	test("a quote that is not there is refused, and says to read the section again", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "a sentence nobody wrote", new: "x", section: "s2" }],
		});

		expect(result.isError).toBe(true);
		expect(result.body).toEqual({
			refused:
				"That passage is not in s2. It may have changed since you read it.",
			next: 'Read the section again (read_note with sections: ["s2"]) and quote what it says now.',
		});
	});

	test("a quote that is in another section says which", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "A reranker call costs", new: "x", section: "s2" }],
		});

		expect(result.isError).toBe(true);
		expect(String(result.body.next)).toContain("It occurs in s3");
	});

	test("a quote that occurs twice is refused, with what to do", async () => {
		const { call } = await fresh();

		// "Fusion keeps" opens every sentence of the long note's three long sections.
		const result = await call("edit", {
			note: "research/long-note",
			edits: [{ old: "Fusion keeps the best", new: "x" }],
		});

		expect(result.isError).toBe(true);
		expect(String(result.body.refused)).toMatch(/occurs \d+ times in the note/);
		expect(result.body.next).toBe(
			"Quote more of the surrounding text so it occurs once, or name the section to look in.",
		);
		// Nothing was written.
		expect((await read(call, "research/long-note")).version).toBe(1);
	});

	test("a quote that crosses a section boundary is refused", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "judges whether each passage actually answers the question asked.\n\n## Cost",
					new: "x",
				},
			],
		});

		expect(result.isError).toBe(true);
		expect(result.body.refused).toBe(
			"That passage runs across sections s2 and s3.",
		);
	});

	test("several edits land together or not at all", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "Jev then rereads the shortlist",
					new: "Jev then rereads the top candidates",
				},
				{ old: "this is not in the note", new: "x" },
			],
		});

		expect(result.isError).toBe(true);
		expect(String(result.body.refused)).toMatch(/^Edit 2: /);
		const note = await read(call, "research/jev-reranker");
		expect(note.version).toBe(1);
		expect(textOf(note)).toContain("Jev then rereads the shortlist");

		const together = await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "Jev then rereads the shortlist",
					new: "Jev then rereads the top candidates",
				},
				{ old: "a fraction of a cent", new: "under a cent" },
			],
		});
		expect(together.body).toMatchObject({ version: 2 });
		expect((together.body.sections as unknown[]).length).toBe(2);
	});

	test("a whole section is replaced only while it is the version the agent read", async () => {
		const { call } = await fresh();
		const text = "## Cost\n\nCosts are small.\n";

		const stale = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ section: "s3", text, version: 2 }],
		});
		const current = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ section: "s3", text, version: 1 }],
		});

		expect(stale.isError).toBe(true);
		expect(stale.body).toEqual({
			refused:
				"s3 is at version 1; you read version 2. It changed since you read it.",
			next: 'Read it again (read_note with sections: ["s3"]) and redo the replacement, or quote a passage instead.',
		});
		expect(current.body).toMatchObject({
			sections: [{ id: "s3", version: 2 }],
		});
		expect(textOf(await read(call, "research/jev-reranker"))).toContain(
			"## Cost\n\nCosts are small.\n",
		);
	});

	test("replacing a section that another session already replaced is refused, and the first replacement stands", async () => {
		const home = await storeHome();
		const one = await session(home);
		const two = await session(home);
		const edits = (text: string) => [
			{ section: "s2", text: `## Key findings\n\n${text}\n`, version: 1 },
		];

		const first = await one.call("edit", {
			note: "research/jev-reranker",
			edits: edits("Fusion is rank based."),
		});
		const second = await two.call("edit", {
			note: "research/jev-reranker",
			edits: edits("Fusion is score based."),
		});

		expect(first.isError).toBe(false);
		expect(second.isError).toBe(true);
		expect(String(second.body.refused)).toContain(
			"s2 is at version 2; you read version 1",
		);
		expect(textOf(await read(one.call, "research/jev-reranker"))).toContain(
			"Fusion is rank based.",
		);
	});

	test("new text with a heading line starts a new section there", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "Jev then rereads the shortlist",
					new: "Jev then rereads the shortlist.\n\n### Caveat\n\nIt is slow",
					section: "s2",
				},
			],
		});

		expect(result.body).toMatchObject({
			sections: [
				{ id: "s2", version: 2 },
				{ id: "s4", version: 1 },
			],
		});
		const note = await read(call, "research/jev-reranker");
		expect(
			(
				note.outline as Array<{ id: string; heading: string; depth: number }>
			).map((s) => [s.id, s.heading, s.depth]),
		).toEqual([
			["s1", "Jev as a reranker", 1],
			["s2", "Key findings", 2],
			["s4", "Caveat", 3],
			["s3", "Cost", 2],
		]);
	});

	test("an edit that takes a section's own heading line away is refused", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "## Cost\n\n", new: "", section: "s3" }],
		});

		expect(result.isError).toBe(true);
		expect(String(result.body.refused)).toContain(
			'removes the heading line of s3 ("Cost")',
		);
	});

	test("an edit that changes the heading's words keeps the section and its id", async () => {
		const { call } = await fresh();

		await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "## Cost", new: "## What it costs", section: "s3" }],
		});

		const note = await read(call, "research/jev-reranker");
		expect(
			(note.outline as Array<{ id: string; heading: string }>)[2],
		).toMatchObject({
			id: "s3",
			heading: "What it costs",
		});
	});

	test("an edit with nothing to do says so", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "fraction of a cent", new: "fraction of a cent" }],
		});

		expect(result.isError).toBe(true);
		expect(String(result.body.refused)).toContain("Nothing changed");
	});

	test("a note that is not there is refused with near matches", async () => {
		const { call } = await fresh();

		const result = await call("edit", {
			note: "research/jev-rerank",
			edits: [{ old: "a", new: "b" }],
		});

		expect(result.isError).toBe(true);
		expect(String(result.body.next)).toContain("research/jev-reranker");
	});
});

describe("sections", () => {
	test("add_section puts a new section where it is told, with an id that was never used", async () => {
		const { call } = await fresh();

		const added = await call("add_section", {
			note: "research/jev-reranker",
			heading: "Limits",
			text: "It adds latency.",
			after: "s2",
		});
		const atStart = await call("add_section", {
			note: "research/jev-reranker",
			heading: "Summary",
			after: "start",
			depth: 1,
		});
		const atEnd = await call("add_section", {
			note: "research/jev-reranker",
			heading: "See also",
			text: "- [[/topic/jev]]",
		});

		expect(added.body).toMatchObject({ sections: [{ id: "s4", version: 1 }] });
		expect(atStart.body).toMatchObject({
			sections: [{ id: "s5", version: 1 }],
		});
		expect(atEnd.body).toMatchObject({ sections: [{ id: "s6", version: 1 }] });
		const note = await read(call, "research/jev-reranker");
		expect(
			(
				note.outline as Array<{ id: string; heading: string; depth: number }>
			).map((s) => `${s.id}:${s.depth}:${s.heading}`),
		).toEqual([
			"s5:1:Summary",
			"s1:1:Jev as a reranker",
			"s2:2:Key findings",
			"s4:2:Limits",
			"s3:2:Cost",
			"s6:2:See also",
		]);
		expect(textOf(note)).toContain("## Limits\n\nIt adds latency.\n");
		expect(textOf(note).endsWith("## See also\n\n- [[/topic/jev]]\n")).toBe(
			true,
		);
	});

	test("remove_section takes a section out and its id is not reused; its subsections stay unless asked", async () => {
		const { call } = await fresh();
		await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "judges whether each passage actually answers the question asked.",
					new: "judges whether each passage actually answers the question asked.\n\n### Detail\n\nMore.",
					section: "s2",
				},
			],
		});

		const alone = await call("remove_section", {
			note: "research/jev-reranker",
			section: "s2",
		});
		const rest = await read(call, "research/jev-reranker");
		const withKids = await call("remove_section", {
			note: "research/jev-reranker",
			section: "s1",
			with_subsections: true,
		});

		expect(alone.isError).toBe(false);
		expect(alone.body.info).toBe(
			"1 nested sections stay; pass with_subsections to remove them too.",
		);
		expect((rest.outline as Array<{ id: string }>).map((s) => s.id)).toEqual([
			"s1",
			"s4",
			"s3",
		]);
		// Everything is nested under the title, so removing it with its
		// subsections would leave the note with no text.
		expect(withKids.isError).toBe(true);
		expect(withKids.body.refused).toBe(
			"That would leave the note with no text.",
		);
		const added = await call("add_section", {
			note: "research/jev-reranker",
			heading: "New",
		});
		expect(added.body).toMatchObject({ sections: [{ id: "s5" }] });
	});

	test("move_section moves a section with its subsections, and refuses a move into itself", async () => {
		const { call } = await fresh();
		await call("add_section", {
			note: "research/jev-reranker",
			heading: "Deeper",
			depth: 3,
			after: "s2",
		});

		const moved = await call("move_section", {
			note: "research/jev-reranker",
			section: "s2",
			after: "s3",
		});
		const into = await call("move_section", {
			note: "research/jev-reranker",
			section: "s2",
			after: "s4",
		});
		const nowhere = await call("move_section", {
			note: "research/jev-reranker",
			section: "s3",
			after: "s1",
		});

		expect(moved.isError).toBe(false);
		const note = await read(call, "research/jev-reranker");
		expect((note.outline as Array<{ id: string }>).map((s) => s.id)).toEqual([
			"s1",
			"s3",
			"s2",
			"s4",
		]);
		expect(into.body.refused).toBe("s4 is inside the section being moved.");
		expect(nowhere.body.refused).toBe("s3 is already there.");
		// Moving changes no section's text, so no section's version.
		expect(outlineOf(note).map((s) => s[1])).toEqual([1, 1, 1, 1]);
	});

	test("a section that does not exist is refused with the ones that do", async () => {
		const { call } = await fresh();

		const result = await call("remove_section", {
			note: "research/jev-reranker",
			section: "s9",
		});

		expect(result.body).toEqual({
			refused: "research/jev-reranker has no section s9.",
			next: "Its sections are s1, s2, s3. read_note shows each with its heading.",
		});
	});
});

describe("append", () => {
	test("adds a bullet under Key findings, continuing the list, and a source joins the note once", async () => {
		const { call } = await fresh();
		await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "judges whether each passage actually answers the question asked.",
					new: "judges whether each passage actually answers the question asked.\n\n- first finding",
					section: "s2",
				},
			],
		});

		const first = await call("append", {
			note: "research/jev-reranker",
			text: "- second finding",
			source: "https://example.com/rerank",
		});
		const again = await call("append", {
			note: "research/jev-reranker",
			text: "- third finding",
			source: "https://example.com/rerank",
		});

		expect(first.body).toMatchObject({ sections: [{ id: "s2", version: 3 }] });
		expect(again.body.info).toBe("That source was already listed.");
		const note = await read(call, "research/jev-reranker");
		expect(textOf(note)).toContain(
			"- first finding\n- second finding\n- third finding\n\n## Cost",
		);
		expect(note.sources).toEqual([
			"../topic/jev.md",
			"https://example.com/jev",
			"https://example.com/rerank",
		]);
	});

	test("a paragraph goes after a blank line", async () => {
		const { call } = await fresh();

		await call("append", {
			note: "research/jev-reranker",
			text: "A new paragraph of findings.",
		});

		expect(textOf(await read(call, "research/jev-reranker"))).toContain(
			"asked.\n\nA new paragraph of findings.\n\n## Cost",
		);
	});

	test("goes in the last section when there is no Key findings, and in a hub's Research list", async () => {
		const { call } = await fresh();

		const plain = await call("append", {
			note: "research/exa-limits",
			text: "Another limit.",
		});
		const hub = await call("append", {
			note: "topic/jev",
			text: "- [Jev costs](../research/jev-costs.md)",
		});

		expect(plain.body).toMatchObject({ sections: [{ id: "s1" }] });
		expect(hub.body).toMatchObject({ sections: [{ id: "s2" }] });
		expect(textOf(await read(call, "topic/jev"))).toContain(
			"[[/research/jev-costs]] has not been written.\n- [Jev costs](../research/jev-costs.md)\n",
		);
	});

	test("to a named section, and a finding with a heading starts a section", async () => {
		const { call } = await fresh();

		const result = await call("append", {
			note: "research/jev-reranker",
			text: "More about cost.\n\n### Detail\n\nSmall print.",
			section: "s3",
		});

		expect(result.body).toMatchObject({
			sections: [
				{ id: "s3", version: 2 },
				{ id: "s4", version: 1 },
			],
		});
	});
});

describe("set_fields", () => {
	test("sets, adds and removes, without touching the text", async () => {
		const { call } = await fresh();

		const done = await call("set_fields", {
			note: "research/jev-reranker",
			title: "Jev as a search reranker",
			status: "reviewed",
			stale_after: "2027-06-30",
			add_tags: ["rerank"],
			remove_tags: ["search"],
			add_sources: ["https://example.com/new"],
		});

		expect(done.isError).toBe(false);
		expect(done.body).toMatchObject({ version: 2 });
		expect(done.body.sections).toBeUndefined();
		const note = await read(call, "research/jev-reranker");
		expect(note).toMatchObject({
			title: "Jev as a search reranker",
			status: "reviewed",
			stale_after: "2027-06-30",
			tags: ["jev", "rerank"],
		});
		expect(note.sources).toEqual([
			"../topic/jev.md",
			"https://example.com/jev",
			"https://example.com/new",
		]);
		expect(outlineOf(note).map((s) => s[1])).toEqual([1, 1, 1]);
	});

	test("an empty stale_after clears it, and a bad date is refused", async () => {
		const { call } = await fresh();
		await call("set_fields", {
			note: "research/exa-limits",
			stale_after: "2027-01-01",
		});

		const cleared = await call("set_fields", {
			note: "research/exa-limits",
			stale_after: "",
		});
		const bad = await call("set_fields", {
			note: "research/exa-limits",
			stale_after: "soon",
		});

		expect(cleared.isError).toBe(false);
		expect((await read(call, "research/exa-limits")).stale_after).toBeNull();
		expect(bad.body.refused).toBe('"soon" is not a date.');
	});

	test("naming the version read refuses the change once the note has moved on", async () => {
		const { call } = await fresh();
		await call("append", { note: "research/exa-limits", text: "More." });

		const stale = await call("set_fields", {
			note: "research/exa-limits",
			version: 1,
			status: "reviewed",
		});
		const current = await call("set_fields", {
			note: "research/exa-limits",
			version: 2,
			status: "reviewed",
		});

		expect(stale.body.refused).toBe(
			"research/exa-limits is at version 2; you read version 1. It changed since you read it.",
		);
		expect(current.isError).toBe(false);
	});

	test("values the note already has change nothing and make no change", async () => {
		const { call } = await fresh();

		const same = await call("set_fields", {
			note: "research/exa-limits",
			tags: ["exa"],
		});

		expect(same.isError).toBe(false);
		expect(same.body).toMatchObject({ unchanged: true, version: 1 });
		expect(
			(await call("history", { note: "research/exa-limits" })).body,
		).toMatchObject({
			changes: [{ kind: "import" }],
		});
	});

	test("clearing the old mark of an old note is a change in the history", async () => {
		const home = await storeHome({ library: true });
		const { call } = await session(home);
		expect((await read(call, "v1/exa/limits")).old).toBe(true);

		const done = await call("set_fields", {
			note: "v1/exa/limits",
			remove_tags: ["old"],
			stale_after: "",
			reason: "brought up to date",
		});

		expect(done.isError).toBe(false);
		const note = await read(call, "v1/exa/limits");
		expect(note.old).toBeUndefined();
		expect(note.tags).toEqual(["exa"]);
		const changes = await call("history", { note: "v1/exa/limits" });
		expect(at(changes.body, "changes", 0)).toMatchObject({
			kind: "set_fields",
			reason: "brought up to date",
		});
	});
});

describe("rename_note and archive_note", () => {
	test("a rename gives a new name, and the old name and every link to it keep working", async () => {
		const { call } = await fresh();
		// topic/jev links to research/jev-reranker; research/jev-reranker links to topic/jev.
		expect((await call("links", { name: "topic/jev" })).body.out).toEqual([
			{
				to: "research/jev-reranker",
				title: "Jev as a reranker",
				kind: "markdown",
				text: "Jev as a reranker",
			},
		]);

		const renamed = await call("rename_note", {
			note: "research/jev-reranker",
			title: "Jev as a Lattice reranker",
		});

		expect(renamed.body).toMatchObject({
			note: "research/jev-as-a-lattice-reranker",
			version: 2,
		});
		const byOld = await read(call, "research/jev-reranker");
		expect(byOld).toMatchObject({
			name: "research/jev-as-a-lattice-reranker",
			answers_to: "research/jev-reranker",
			title: "Jev as a Lattice reranker",
		});
		// The hub's link was written to the old name and still reaches the note.
		const hub = await call("links", { name: "topic/jev" });
		expect(at(hub.body, "out", 0, "to")).toBe(
			"research/jev-as-a-lattice-reranker",
		);
		const back = await call("links", {
			name: "research/jev-as-a-lattice-reranker",
		});
		expect(at(back.body, "in", 0, "from")).toBe("topic/jev");
		// A new note cannot take the old name.
		const clash = await call("create_note", {
			type: "Research",
			title: "Jev reranker",
		});
		expect(clash.isError).toBe(true);
		expect(clash.body.refused).toBe(
			"research/jev-reranker is an old name of research/jev-as-a-lattice-reranker.",
		);
	});

	test("a link to a note written before the note existed is picked up when a note takes the name", async () => {
		const { call } = await fresh();
		// topic/jev links to [[/research/jev-costs]], which is not written yet.
		expect(
			(await call("links", { name: "topic/jev" })).body.unwritten,
		).toHaveLength(1);

		await call("create_note", { type: "Research", title: "Jev costs" });

		const hub = await call("links", { name: "topic/jev" });
		expect(hub.body.unwritten).toEqual([]);
		expect(at(hub.body, "out", 1, "to")).toBe("research/jev-costs");
	});

	test("a rename to a name another note has is refused, naming that note", async () => {
		const { call } = await fresh();

		const result = await call("rename_note", {
			note: "research/jev-reranker",
			title: "Exa limits",
		});

		expect(result.isError).toBe(true);
		expect(result.body.refused).toBe(
			"A note named research/exa-limits already exists (What Exa search is not good for).",
		);
	});

	test("a new type moves the note to its folder and its relative links still reach the same notes", async () => {
		const { call } = await fresh();
		// topic/jev links to ../research/jev-reranker.md; moving it to Research keeps that link whole.
		await call("rename_note", { note: "topic/jev", type: "Research" });

		const note = await read(call, "research/jev");
		expect(note.name).toBe("research/jev");
		expect(textOf(note)).toContain("(jev-reranker.md)");
		const links = await call("links", { name: "research/jev" });
		expect(at(links.body, "out", 0, "to")).toBe("research/jev-reranker");
	});

	test("archive_note hides a note from recall and listings; undoing it brings it back", async () => {
		const { call } = await fresh();

		const done = await call("archive_note", { note: "research/exa-limits" });

		expect(done.isError).toBe(false);
		const found = await call("recall", { question: "Exa exact phrase" });
		expect(JSON.stringify(found.body)).not.toContain("research/exa-limits");
		const listed = await call("list_notes", { type: "Research" });
		expect(
			(listed.body.notes as Array<{ name: string }>).map((n) => n.name),
		).not.toContain("research/exa-limits");
		expect((await read(call, "research/exa-limits")).archived).toBe(true);
		const withIt = await call("recall", {
			question: "Exa exact phrase",
			include_archived: true,
		});
		expect(at(withIt.body, "passages", 0, "note")).toBe("research/exa-limits");

		const twice = await call("archive_note", { note: "research/exa-limits" });
		expect(twice.isError).toBe(true);

		const undone = await call("revert", { change: Number(done.body.change) });
		expect(undone.isError).toBe(false);
		const back = await call("recall", { question: "Exa exact phrase" });
		expect(at(back.body, "passages", 0, "note")).toBe("research/exa-limits");
	});
});

describe("confirm", () => {
	test("an agent's check is shown as agent, James's as james, and a later write unchecks only the section it touched", async () => {
		const { call } = await fresh();

		const agent = await call("confirm", {
			note: "research/jev-reranker",
			sections: ["s2", "s3"],
			by: "checker",
			reason: "checked against the sources",
		});
		const james = await call("confirm", {
			note: "research/jev-reranker",
			sections: ["s2"],
			james_said: "Yes, that finding is right.",
		});

		expect(agent.isError).toBe(false);
		expect(james.isError).toBe(false);
		let note = await read(call, "research/jev-reranker");
		expect(outlineOf(note)).toEqual([
			["s1", 1, "unchecked"],
			["s2", 1, "james"],
			["s3", 1, "agent"],
		]);
		expect(note.checked).toBe(2);
		const recalled = await call("recall", {
			question: "reciprocal rank fusion",
		});
		expect(at(recalled.body, "passages", 0, "checked")).toBe("james");

		await call("append", {
			note: "research/jev-reranker",
			text: "A later finding.",
		});

		note = await read(call, "research/jev-reranker");
		expect(outlineOf(note)).toEqual([
			["s1", 1, "unchecked"],
			["s2", 2, "unchecked"],
			["s3", 1, "agent"],
		]);
		const detail = await call("history", { note: "research/jev-reranker" });
		expect(
			(detail.body.changes as Array<{ kind: string; reason?: string }>)
				.map((c) => [c.kind, c.reason])
				.slice(0, 3),
		).toEqual([
			["append", undefined],
			["confirm", "James said: Yes, that finding is right."],
			["confirm", "checked against the sources"],
		]);
	});

	test("an agent's check does not replace James's, and checking what is checked changes nothing", async () => {
		const { call } = await fresh();
		await call("confirm", {
			note: "research/exa-limits",
			james_said: "Fine.",
		});

		const agent = await call("confirm", { note: "research/exa-limits" });

		expect(agent.isError).toBe(false);
		expect(agent.body).toMatchObject({ unchanged: true });
		expect(outlineOf(await read(call, "research/exa-limits"))[0][2]).toBe(
			"james",
		);
	});

	test("james_said empty is refused", async () => {
		const { call } = await fresh();

		const result = await call("confirm", {
			note: "research/exa-limits",
			james_said: " ",
		});

		expect(result.isError).toBe(true);
	});
});

describe("revert", () => {
	test("undoes one change and leaves the changes before and after it", async () => {
		const { call } = await fresh();
		const a = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "fraction of a cent", new: "tenth of a cent" }],
		});
		const b = await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{ old: "reciprocal rank fusion", new: "Reciprocal Rank Fusion" },
			].map((e) => ({
				...e,
				old: "Reciprocal rank fusion",
				new: "Reciprocal Rank Fusion",
			})),
		});

		const undone = await call("revert", {
			change: Number(a.body.change),
			reason: "wrong number",
		});

		expect(undone.isError).toBe(false);
		expect(undone.body).toMatchObject({
			version: 4,
			sections: [{ id: "s3", version: 3 }],
		});
		const text = textOf(await read(call, "research/jev-reranker"));
		expect(text).toContain("fraction of a cent");
		expect(text).not.toContain("tenth of a cent");
		expect(text).toContain("Reciprocal Rank Fusion");
		const log = await call("history", { note: "research/jev-reranker" });
		expect(at(log.body, "changes", 0)).toMatchObject({
			kind: "revert",
			undoes: Number(a.body.change),
			reason: "wrong number",
			version: 4,
		});
		expect(
			(log.body.changes as Array<{ change: number; undone?: boolean }>).find(
				(c) => c.change === Number(a.body.change),
			)?.undone,
		).toBe(true);
		expect(b.isError).toBe(false);
	});

	test("is refused when a later change touched the same section, naming that change", async () => {
		const { call } = await fresh();
		const a = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "fraction of a cent", new: "tenth of a cent" }],
		});
		const b = await call("edit", {
			note: "research/jev-reranker",
			edits: [{ old: "Small", new: "x" }].map(() => ({
				old: "for a whole shortlist",
				new: "for the whole shortlist",
			})),
		});

		const undone = await call("revert", { change: Number(a.body.change) });

		expect(undone.isError).toBe(true);
		expect(undone.body.refused).toBe(
			`Change ${b.body.change} (edit, by test-client 1.2.3, ${new Date().toISOString().slice(0, 10)}) also changed section s3, after change ${a.body.change}.`,
		);
		expect(undone.body.next).toBe(
			`Undo change ${b.body.change} first, or edit section s3 directly.`,
		);
	});

	test("an undo can itself be undone, and the first change stands again", async () => {
		const { call } = await fresh();
		const a = await call("edit", {
			note: "research/exa-limits",
			edits: [{ old: "cannot match", new: "cannot always match" }],
		});
		const undo = await call("revert", { change: Number(a.body.change) });
		expect(textOf(await read(call, "research/exa-limits"))).toContain(
			"Exa neural search cannot match an exact",
		);

		const redo = await call("revert", { change: Number(undo.body.change) });

		expect(redo.isError).toBe(false);
		const log = await call("history", { note: "research/exa-limits" });
		const byId = new Map(
			(log.body.changes as Array<{ change: number; undone?: boolean }>).map(
				(c) => [c.change, c],
			),
		);
		expect(byId.get(Number(a.body.change))?.undone).toBeUndefined();
		expect(byId.get(Number(undo.body.change))?.undone).toBe(true);
	});

	test("a change already undone is refused, naming the undo", async () => {
		const { call } = await fresh();
		const a = await call("append", {
			note: "research/exa-limits",
			text: "More.",
		});
		const undo = await call("revert", { change: Number(a.body.change) });

		const again = await call("revert", { change: Number(a.body.change) });

		expect(again.body.refused).toBe(
			`Change ${a.body.change} was already undone by change ${undo.body.change}.`,
		);
	});

	test("undoes a removed section, putting it back where it was with its id", async () => {
		const { call } = await fresh();
		const removed = await call("remove_section", {
			note: "research/jev-reranker",
			section: "s2",
		});

		const undone = await call("revert", {
			change: Number(removed.body.change),
		});

		expect(undone.isError).toBe(false);
		const note = await read(call, "research/jev-reranker");
		expect(textOf(note).startsWith("\n# Jev as a reranker")).toBe(true);
		expect((note.outline as Array<{ id: string }>).map((s) => s.id)).toEqual([
			"s1",
			"s2",
			"s3",
		]);
		expect(textOf(note)).toContain("## Key findings\n\nReciprocal rank fusion");
	});

	test("undoes an added section, a move, a rename, a fields change and a check", async () => {
		const { call } = await fresh();
		const before = await read(call, "research/jev-reranker");

		const added = await call("add_section", {
			note: "research/jev-reranker",
			heading: "X",
		});
		const moved = await call("move_section", {
			note: "research/jev-reranker",
			section: "s3",
			after: "s1",
		});
		const fields = await call("set_fields", {
			note: "research/jev-reranker",
			status: "reviewed",
			add_tags: ["x"],
		});
		const checked = await call("confirm", {
			note: "research/jev-reranker",
			sections: ["s1"],
		});
		const renamed = await call("rename_note", {
			note: "research/jev-reranker",
			title: "Another title",
		});

		for (const change of [renamed, checked, fields, moved, added]) {
			const undone = await call("revert", {
				change: Number(change.body.change),
			});
			expect(undone.isError).toBe(false);
		}

		const after = await read(call, "research/jev-reranker");
		expect(after).toMatchObject({
			name: "research/jev-reranker",
			title: before.title,
			status: before.status,
			tags: before.tags,
			checked: 0,
		});
		expect(textOf(after)).toBe(textOf(before));
		expect(after.version).toBe(11);
	});

	test("puts a whole note back as at an earlier version, as a new change", async () => {
		const { call } = await fresh();
		const original = await read(call, "research/jev-reranker");
		await call("append", {
			note: "research/jev-reranker",
			text: "A wrong finding.",
		});
		await call("remove_section", {
			note: "research/jev-reranker",
			section: "s3",
		});
		await call("set_fields", {
			note: "research/jev-reranker",
			status: "wrong",
		});
		await call("add_section", {
			note: "research/jev-reranker",
			heading: "Junk",
		});

		const back = await call("revert", {
			note: "research/jev-reranker",
			version: 1,
		});

		expect(back.isError).toBe(false);
		expect(back.body).toMatchObject({ version: 6 });
		const now = await read(call, "research/jev-reranker");
		expect(textOf(now)).toBe(textOf(original));
		expect(now.status).toBe(original.status);
		expect((now.outline as Array<{ id: string }>).map((s) => s.id)).toEqual([
			"s1",
			"s2",
			"s3",
		]);
		expect(
			await call("history", { note: "research/jev-reranker", limit: 1 }),
		).toMatchObject({
			body: { changes: [{ kind: "revert", version: 6 }] },
		});

		const same = await call("revert", {
			note: "research/jev-reranker",
			version: 6,
		});
		expect(same.body).toMatchObject({ unchanged: true });
		const nowhere = await call("revert", {
			note: "research/jev-reranker",
			version: 99,
		});
		expect(nowhere.body.refused).toBe(
			"research/jev-reranker has no version 99; its versions run from 1 to 6.",
		);
	});

	test("undoes an edit that split a section: the new section goes, the old one reads as it did", async () => {
		const { call } = await fresh();
		const before = textOf(await read(call, "research/jev-reranker"));
		const split = await call("edit", {
			note: "research/jev-reranker",
			edits: [
				{
					old: "judges whether each passage actually answers the question asked.",
					new: "judges whether each passage answers.\n\n### Caveat\n\nIt is slow.",
					section: "s2",
				},
			],
		});
		expect((split.body.sections as unknown[]).length).toBe(2);

		const undone = await call("revert", { change: Number(split.body.change) });

		expect(undone.isError).toBe(false);
		const note = await read(call, "research/jev-reranker");
		expect(textOf(note)).toBe(before);
		expect(outlineOf(note)).toEqual([
			["s1", 1, "unchecked"],
			["s2", 3, "unchecked"],
			["s3", 1, "unchecked"],
		]);
	});

	test("undoes a type change that moved the note and rewrote its links, and the links read as they did", async () => {
		const { call } = await fresh();
		const before = textOf(await read(call, "topic/jev"));
		const moved = await call("rename_note", {
			note: "topic/jev",
			type: "Research",
		});
		expect(textOf(await read(call, "research/jev"))).not.toBe(before);

		const undone = await call("revert", { change: Number(moved.body.change) });

		expect(undone.isError).toBe(false);
		const note = await read(call, "topic/jev");
		expect(note).toMatchObject({ name: "topic/jev", type: "Topic" });
		expect(textOf(note)).toBe(before);
		const links = await call("links", { name: "topic/jev" });
		expect(at(links.body, "out", 0, "to")).toBe("research/jev-reranker");
		// The name the move gave up, research/jev, still answers.
		expect((await read(call, "research/jev")).name).toBe("topic/jev");
	});

	test("a change that made the note cannot be undone, and says what to use", async () => {
		const { call } = await fresh();
		const made = await call("create_note", { type: "Topic", title: "Temp" });

		const result = await call("revert", { change: Number(made.body.change) });

		expect(result.isError).toBe(true);
		expect(result.body.next).toContain("archive_note");
	});

	test("with neither a change nor a note and version it says what to give", async () => {
		const { call } = await fresh();

		const result = await call("revert", {});

		expect(result.isError).toBe(true);
		expect(String(result.body.next)).toContain("history");
	});
});

describe("reading an earlier version", () => {
	test("every version reads back exactly as the note was, section versions and checked marks included", async () => {
		const { call } = await fresh();
		const name = "research/jev-reranker";
		const seen: Body[] = [await read(call, name)];
		const step = async (tool: string, args: Record<string, unknown>) => {
			const result = await call(tool, { note: name, ...args });
			expect(result.isError).toBe(false);
			seen.push(await read(call, name));
			return Number(result.body.change);
		};

		await step("edit", {
			edits: [{ old: "fraction of a cent", new: "tenth of a cent" }],
		});
		await step("confirm", { sections: ["s2", "s3"] });
		await step("append", { text: "- one", section: "s2" });
		const extra = await step("add_section", { heading: "Extra", after: "s2" });
		await step("move_section", { section: "s3", after: "start" });
		await step("edit", {
			edits: [{ old: "tenth of a cent", new: "twentieth of a cent" }],
		});
		await step("remove_section", { section: "s2" });
		await step("set_fields", { status: "reviewed", add_tags: ["t"] });
		await step("confirm", { sections: ["s3"], james_said: "ok" });
		// Nothing later touched the added section, so its undo is allowed.
		await step("revert", { change: extra, note: undefined });

		for (let version = 1; version <= seen.length; version++) {
			const was = await read(call, name, { version });
			const wanted = seen[version - 1];
			expect({
				v: version,
				outline: was.outline,
				text: was.text,
				status: was.status,
				tags: was.tags,
			}).toEqual({
				v: version,
				outline: wanted.outline,
				text: wanted.text,
				status: wanted.status,
				tags: wanted.tags,
			});
		}
	});
});

describe("when the model cannot embed", () => {
	test("a write still lands, is found by keyword, and the failure is reported", async () => {
		const home = await storeHome();
		const { call } = await session(home, {
			env: { LATTICE_EMBED_FAIL: "permanent:Zirconium" },
		});

		const made = await call("create_note", {
			type: "Research",
			title: "Zirconium Alloys",
			text: "Zirconium alloys resist corrosion in reactors.",
		});

		expect(made.isError).toBe(false);
		expect(made.body.search).toMatch(
			/^1 new passages are found by keyword only: embedding failed/,
		);
		const found = await call("recall", {
			question: "zirconium corrosion reactors",
		});
		expect(at(found.body, "passages", 0, "note")).toBe(
			"research/zirconium-alloys",
		);
		expect(found.body.passages_without_vectors).toBe(1);
		const stats = await call("stats");
		expect(at(stats.body, "search", "ok")).toBe(false);
		expect(at(stats.body, "search", "failed")).toBeGreaterThanOrEqual(1);
		// The write is in the history like any other.
		const log = await call("history", { note: "research/zirconium-alloys" });
		expect(at(log.body, "changes", 0, "kind")).toBe("create");
	});

	test("with no model at all a write still lands and says its text is found by keyword", async () => {
		const home = await storeHome();
		const { call } = await session(home, {
			env: { LATTICE_EMBED_PROVIDER: "no-such-provider" },
		});

		const result = await call("append", {
			note: "research/exa-limits",
			text: "Yet another limit.",
		});

		expect(result.isError).toBe(false);
		expect(String(result.body.search)).toContain("found by keyword only");
		const found = await call("recall", { question: "yet another limit" });
		expect(at(found.body, "passages", 0, "note")).toBe("research/exa-limits");
	});
});

describe("snapshots", () => {
	test("the first write of a day takes a snapshot, a second takes none, and the snapshot is the store as it was before", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		const dir = join(home, "backups");
		expect(existsSync(dir)).toBe(false);
		expect((await call("stats")).body.last_backup).toBeNull();

		await call("append", { note: "research/exa-limits", text: "First write." });
		const taken = readdirSync(dir);
		await call("append", {
			note: "research/exa-limits",
			text: "Second write.",
		});

		expect(taken).toHaveLength(1);
		expect(taken[0]).toMatch(/^store-\d{4}-\d{2}-\d{2}\.db$/);
		expect(readdirSync(dir)).toEqual(taken);
		const stats = await call("stats");
		expect(stats.body.last_backup).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// It is a whole store, and it holds the note without the first write.
		const snapshot = openStore(join(dir, taken[0]));
		try {
			const row = snapshot
				.query<{ version: number }, []>(
					"SELECT version FROM concepts WHERE identifier = 'research/exa-limits'",
				)
				.get();
			expect(row?.version).toBe(1);
			expect(
				snapshot
					.query<{ n: number }, []>("SELECT count(*) AS n FROM concepts")
					.get()?.n,
			).toBe(4);
		} finally {
			snapshot.close();
		}
	});

	test("reading never takes one", async () => {
		const home = await storeHome();
		const { call } = await session(home);

		await call("recall", { question: "Exa" });
		await call("stats");

		expect(existsSync(join(home, "backups"))).toBe(false);
	});
});

describe("who", () => {
	test("a server started somewhere that is not a project takes the folder from the client's roots", async () => {
		const home = await storeHome();
		const root = mkdtempSync(join(tmpdir(), "lattice-root-"));
		mkdirSync(root, { recursive: true });
		const { server, close } = createLatticeServer({
			env: { ...HASH_ENV, LATTICE_HOME: home },
			project: "/",
		});
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const client = new Client(
			{ name: "roots-client", version: "1.0.0" },
			{ capabilities: { roots: {} } },
		);
		client.setRequestHandler(ListRootsRequestSchema, () => ({
			roots: [{ uri: `file://${root}`, name: "session" }],
		}));
		await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
		try {
			await client.callTool({
				name: "create_note",
				arguments: { type: "Topic", title: "Roots" },
			});
			const log = await client.callTool({
				name: "history",
				arguments: { note: "topic/roots" },
			});
			const body = JSON.parse((log.content as Array<{ text: string }>)[0].text);
			expect(body.changes[0].who).toEqual({
				client: "roots-client 1.0.0",
				project: root,
			});
		} finally {
			await client.close();
			await server.close();
			close();
		}
	});

	test("the environment's CLAUDE_PROJECT_DIR is used before asking the client", async () => {
		const home = await storeHome();
		const { call } = await session(home, {
			project: "/",
			env: { CLAUDE_PROJECT_DIR: "/work/from-env" },
		});

		await call("create_note", { type: "Topic", title: "Env" });

		const log = await call("history", { note: "topic/env" });
		expect(at(log.body, "changes", 0, "who", "project")).toBe("/work/from-env");
	});

	test("with no folder to be had the change records the client and the name alone", async () => {
		const home = await storeHome();
		const { call } = await session(home, { project: "/" });

		await call("create_note", {
			type: "Topic",
			title: "Nowhere",
			by: "someone",
		});

		const log = await call("history", { note: "topic/nowhere" });
		expect(at(log.body, "changes", 0, "who")).toEqual({
			client: "test-client 1.2.3",
			by: "someone",
		});
	});
});

// The files the tests above never read back, kept here so the import is used.
void readFileSync;
