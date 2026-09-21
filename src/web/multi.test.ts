import { describe, expect, test } from "bun:test";
import { MultiSearcher } from "./multi.js";
import type { WebRequest, WebSearcher } from "./provider.js";

const REQUEST: WebRequest = { query: "q", type: "fast", limit: 5, text: false };

function leg(name: string, urls: string[], fail = false): WebSearcher {
	return {
		name,
		async search() {
			if (fail) {
				throw new Error(`${name} is down`);
			}
			return {
				results: urls.map((url) => ({
					title: null,
					url,
					publishedDate: null,
					author: null,
					highlights: [],
				})),
				cost: 0.01,
				searchTime: null,
				requestId: null,
			};
		},
		async read(url: string) {
			if (fail) {
				throw new Error(`${name} cannot read`);
			}
			return { url, text: `${name} text`, cost: null };
		},
	};
}

describe("MultiSearcher", () => {
	test("later legs are held back until escalate(), then searched with the rest", async () => {
		const multi = new MultiSearcher([leg("a", ["https://a"])], [], {
			legs: [leg("b", ["https://b"])],
			dropped: ["c: no key"],
		});
		expect(multi.active()).toEqual(["a"]);
		const first = await multi.search(REQUEST);
		expect(first.results.map((r) => [r.url, r.leg])).toEqual([
			["https://a", "a"],
		]);
		expect(multi.reasons()).toEqual([]);

		multi.escalate();
		expect(multi.active()).toEqual(["a", "b"]);
		const second = await multi.search(REQUEST);
		expect(second.results.map((r) => [r.url, r.leg])).toEqual([
			["https://a", "a"],
			["https://b", "b"],
		]);
		expect(second.cost).toBeCloseTo(0.02);
		expect(multi.reasons()).toEqual(["c: no key"]);
	});

	test("a failing leg is dropped with its reason; the last one failing throws them all", async () => {
		const multi = new MultiSearcher([
			leg("a", ["https://a"]),
			leg("b", [], true),
		]);
		const response = await multi.search(REQUEST);
		expect(response.results.map((r) => r.url)).toEqual(["https://a"]);
		expect(multi.reasons()).toEqual(["b: b is down"]);
		expect(multi.active()).toEqual(["a"]);

		const dead = new MultiSearcher([leg("x", [], true)]);
		await expect(dead.search(REQUEST)).rejects.toThrow("x: x is down");
	});

	test("when every leg of a round fails, the later legs are searched at once", async () => {
		const multi = new MultiSearcher([leg("a", [], true)], [], {
			legs: [leg("b", ["https://b"])],
			dropped: [],
		});
		const response = await multi.search(REQUEST);
		expect(response.results.map((r) => r.url)).toEqual(["https://b"]);
		expect(multi.active()).toEqual(["b"]);
		expect(multi.reasons()).toEqual(["a: a is down"]);
	});

	test("read tries legs in order and the first that can wins", async () => {
		const multi = new MultiSearcher([
			leg("a", [], true),
			leg("b", ["https://b"]),
		]);
		expect((await multi.read("https://b")).text).toBe("b text");
		const none = new MultiSearcher([leg("a", [], true)]);
		await expect(none.read("https://b")).rejects.toThrow("a cannot read");
	});
});
