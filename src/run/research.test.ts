import { describe, expect, test } from "bun:test";
import { slug } from "./research.js";

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
