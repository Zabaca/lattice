import { describe, expect, test } from "bun:test";
import type { Candidate } from "./judge.js";
import { knownContext, slug, urlsIn, withoutUrls } from "./research.js";

describe("slug", () => {
	test("a title becomes the kebab-case filename its type directory would", () => {
		expect(slug("Tesla Model S value retention")).toBe(
			"tesla-model-s-value-retention",
		);
		expect(slug("What Exa's `deep` search costs")).toBe(
			"what-exa-s-deep-search-costs",
		);
		expect(slug("  --RRF: tie handling?  ")).toBe("rrf-tie-handling");
		expect(slug("???")).toBe("");
	});
});

describe("urls in a topic", () => {
	test("are found, deduplicated, and taken out of the question", () => {
		const topic =
			"https://lwn.net/SubscriberLink/1094575/2385e98583715c2b/ and how new features help agentgit";
		const urls = urlsIn(topic);
		expect(urls).toEqual([
			"https://lwn.net/SubscriberLink/1094575/2385e98583715c2b/",
		]);
		expect(withoutUrls(topic, urls)).toBe("how new features help agentgit");
	});

	test("trailing punctuation is not part of the URL, and a repeat is one seed", () => {
		const topic =
			"see http://a.test/x, and http://a.test/x again: what changed?";
		expect(urlsIn(topic)).toEqual(["http://a.test/x"]);
		expect(withoutUrls(topic, urlsIn(topic))).toBe("again: what changed?");
	});

	test("a topic that is only a URL keeps the URL as its question", () => {
		const topic = "https://a.test/page";
		expect(withoutUrls(topic, urlsIn(topic))).toBe(topic);
	});
});

describe("what the bundle knows, for the web planner", () => {
	const hub: Candidate = {
		source: "index",
		title: "agentgit",
		ref: "topic/agentgit.md",
		text: "It has been used on rebases across long-lived branches.",
	};
	const document: Candidate = {
		source: "index",
		title: "Merge conflict resolution",
		ref: "research/merge-conflicts.md",
		text: "Three-way merges are the hard case.",
	};
	const page: Candidate = {
		source: "web",
		title: "A page",
		ref: "https://a.test/x",
		text: "Nothing to do with the bundle.",
	};
	const files: Record<string, string> = {
		"topic/agentgit.md":
			"---\ntype: Topic\ntitle: agentgit\ndescription: An agentic tool for orchestrating git operations.\n---\n\n# agentgit\n",
		"research/merge-conflicts.md":
			"---\ntype: Research\ntitle: Merge conflict resolution\ndescription: How conflicts get resolved.\n---\n\n# Merge\n",
	};
	const read = (path: string): string | undefined => files[path];

	test("the description is lifted from frontmatter, and the bundle path left out", () => {
		expect(knownContext([hub], read)).toBe(
			"agentgit — An agentic tool for orchestrating git operations.\n" +
				"It has been used on rebases across long-lived branches.",
		);
		expect(knownContext([hub], read)).not.toContain("topic/agentgit.md");
	});

	test("hubs come first, web candidates are not bundle knowledge, and nothing kept is nothing said", () => {
		const known = knownContext([document, page, hub], read) as string;
		expect(known.indexOf("agentgit")).toBeLessThan(
			known.indexOf("Merge conflict resolution"),
		);
		expect(known).not.toContain("a.test");
		expect(knownContext([], read)).toBeUndefined();
		expect(knownContext([page], read)).toBeUndefined();
	});

	test("a document that is gone, or has no description, falls back to its title", () => {
		expect(knownContext([hub], () => undefined)).toBe(
			"agentgit\nIt has been used on rebases across long-lived branches.",
		);
		expect(
			knownContext([hub], () => "---\ntype: Topic\ntitle: agentgit\n---\n"),
		).toBe("agentgit\nIt has been used on rebases across long-lived branches.");
	});

	test("one document is capped at 400 characters, cut at a word boundary", () => {
		const long = { ...hub, text: "wordy ".repeat(200) };
		const known = knownContext([long], read) as string;
		expect(known.length).toBeLessThanOrEqual(401);
		expect(known).toEndWith("wordy…");
	});

	test("at most five documents, and one that would overrun the budget is dropped whole", () => {
		const many = Array.from({ length: 8 }, (_, n) => ({
			...document,
			ref: `research/doc-${n}.md`,
			title: `Doc ${n}`,
		}));
		const known = knownContext(many, () => undefined) as string;
		expect(known.split("\n\n")).toHaveLength(5);
		expect(known).toContain("Doc 4");
		expect(known).not.toContain("Doc 5");

		// Five documents each filling their 400 characters overrun the 2000 the
		// whole prompt is allowed, so the last is left out rather than halved.
		const big = Array.from({ length: 5 }, (_, n) => ({
			...document,
			ref: `research/big-${n}.md`,
			title: `Big${n}`,
			text: "x".repeat(600),
		}));
		const budgeted = knownContext(big, () => undefined) as string;
		expect(budgeted.length).toBeLessThanOrEqual(2000);
		expect(budgeted).toContain("Big3");
		expect(budgeted).not.toContain("Big4");
	});
});
