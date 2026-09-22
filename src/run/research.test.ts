import { describe, expect, test } from "bun:test";
import { slug, urlsIn, withoutUrls } from "./research.js";

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
