import { describe, expect, test } from "bun:test";
import { planPrompt, rewritePrompt } from "./runner.js";

/** The strings as they read with nothing to say about the subject; a `lattice run` plan must not drift. */
const PLAIN_PLAN =
	'Write two distinct search queries that together would find sources answering: "how zorblax handles ties". ' +
	'Return JSON only: {"queries": ["...", "..."]}';
const PLAIN_REWRITE =
	'The research question is: "how zorblax handles ties". These queries were tried: ["zorblax","ties"]. ' +
	"A judge said the results were insufficient because: nothing was relevant. " +
	'Write two new, different queries. Return JSON only: {"queries": ["...", "..."]}';

const QUESTION = "how zorblax handles ties";
const TRIED = ["zorblax", "ties"];
const REASON = "nothing was relevant";

describe("the plan prompt", () => {
	test("with no context is what it has always been", () => {
		expect(planPrompt(QUESTION)).toBe(PLAIN_PLAN);
		// An empty context object is no context: research passes `{ held }`
		// with nothing seeded.
		expect(planPrompt(QUESTION, {})).toBe(PLAIN_PLAN);
	});

	test("a held source fixes the subject and is not to be searched around", () => {
		const prompt = planPrompt(QUESTION, { held: "SEED TEXT" });

		expect(prompt).toStartWith("This source is already held");
		expect(prompt).toContain("its subject is the subject of the run");
		expect(prompt).toContain("corroborate what it says");
		expect(prompt).toContain(
			"Do not write a query for something the question mentions that this source does not discuss",
		);
		expect(prompt).toContain("SEED TEXT");
		expect(prompt).toContain(
			"The question is what the queries must answer; what is above is there to say what it is about.",
		);
		expect(prompt).toEndWith('Return JSON only: {"queries": ["...", "..."]}');
		// Nothing about a bundle: only research knows there is one.
		expect(prompt).not.toContain("the bundle already holds");
	});

	test("what the bundle knows asks for the describing words, not the bare name", () => {
		const prompt = planPrompt(QUESTION, { known: "Zorblax — a tie-breaker." });

		expect(prompt).toStartWith("This is what the bundle already holds");
		expect(prompt).toContain("what kind of thing it is, what it does");
		expect(prompt).toContain("rather than its bare name");
		expect(prompt).toContain("Zorblax — a tie-breaker.");
		expect(prompt).not.toContain("This source is already held");
		expect(prompt).not.toContain("Let one query follow");
	});

	test("with both, the held block comes first and one query is asked of each", () => {
		const prompt = planPrompt(QUESTION, {
			held: "SEED TEXT",
			known: "Zorblax — a tie-breaker.",
		});

		expect(prompt.indexOf("This source is already held")).toBeLessThan(
			prompt.indexOf("This is what the bundle already holds"),
		);
		expect(prompt).toContain(
			"Let one query follow from the held source and one from what the bundle knows.",
		);
		expect(prompt.indexOf("Let one query follow")).toBeLessThan(
			prompt.indexOf("Write two distinct search queries"),
		);
	});
});

describe("the rewrite prompt", () => {
	test("with no context is what it has always been", () => {
		expect(rewritePrompt(QUESTION, TRIED, REASON)).toBe(PLAIN_REWRITE);
		expect(rewritePrompt(QUESTION, TRIED, REASON, {})).toBe(PLAIN_REWRITE);
	});

	test("with context keeps the rewrite on the subject rather than on the words", () => {
		const prompt = rewritePrompt(QUESTION, TRIED, REASON, {
			known: "Zorblax — a tie-breaker.",
		});

		expect(prompt).toStartWith("This is what the bundle already holds");
		expect(prompt).toContain("Zorblax — a tie-breaker.");
		expect(prompt).toContain(
			"Write two new, different queries on the same subject: change how you ask, not what you are asking about.",
		);
		expect(prompt).toContain(
			`These queries were tried: ${JSON.stringify(TRIED)}`,
		);
		expect(prompt).toEndWith('Return JSON only: {"queries": ["...", "..."]}');
	});
});
