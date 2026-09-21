import { describe, expect, test } from "bun:test";
import { resultsFrom } from "./claude.js";

const GROUNDED = [
	{ title: "SQLite FTS5 Extension", url: "https://sqlite.org/fts5.html" },
	{ title: "Forum thread", url: "https://sqlite.org/forum/forumpost/abc" },
];

describe("resultsFrom", () => {
	test("keeps grounded URLs in the model's order and drops the rest", () => {
		const text = JSON.stringify({
			results: [
				{
					title: "x",
					url: "https://sqlite.org/forum/forumpost/abc",
					snippet: "The forum says so.",
				},
				{ title: "y", url: "https://made.up/page", snippet: "Invented." },
				{
					title: "z",
					url: "https://sqlite.org/fts5.html/",
					snippet: "bm25 is the rank.",
				},
				{
					title: "z again",
					url: "https://sqlite.org/fts5.html#section",
					snippet: "twice",
				},
			],
		});
		expect(resultsFrom(text, GROUNDED)).toEqual([
			{
				title: "Forum thread",
				url: "https://sqlite.org/forum/forumpost/abc",
				publishedDate: null,
				author: null,
				highlights: ["The forum says so."],
			},
			{
				title: "SQLite FTS5 Extension",
				url: "https://sqlite.org/fts5.html",
				publishedDate: null,
				author: null,
				highlights: ["bm25 is the rank."],
			},
		]);
	});

	test("tolerates prose and a code fence around the JSON", () => {
		const text =
			'Here is what I found:\n```json\n{"results":[{"title":"t","url":"https://sqlite.org/fts5.html","snippet":"s"}]}\n```\nHope that helps.';
		expect(resultsFrom(text, GROUNDED).map((r) => r.url)).toEqual([
			"https://sqlite.org/fts5.html",
		]);
	});

	test("no JSON, broken JSON or no results array is empty", () => {
		expect(resultsFrom("I could not search.", GROUNDED)).toEqual([]);
		expect(resultsFrom("{not json}", GROUNDED)).toEqual([]);
		expect(resultsFrom('{"answer": "x"}', GROUNDED)).toEqual([]);
	});
});
