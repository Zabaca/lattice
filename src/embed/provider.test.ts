import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectProvider } from "./provider.js";

/** A home the provider can name a cache under; nothing is written to it here. */
const HOME = join(tmpdir(), "lattice-provider-test");

function select(env: Record<string, string | undefined> = {}) {
	return selectProvider({ LATTICE_HOME: HOME, ...env });
}

/**
 * The provider seam: what the CLI cannot show without a real model on disk.
 *
 * Selecting a provider must not load or download anything — that is what
 * makes it testable, and what keeps `lattice --help` from fetching 100 MB.
 */
describe("selectProvider", () => {
	test("defaults to the local model and says so", () => {
		const provider = select();

		expect(provider.model).toBe("all-minilm-l6-v2-384");
		expect(provider.dim).toBe(384);
		expect(provider.source).toBe("the default");
	});

	test("normalises the written form of a model name", () => {
		const spellings = [
			"all-MiniLM-L6-v2",
			"Xenova/all-MiniLM-L6-v2",
			"  ALL-MINILM-L6-V2  ",
		];

		for (const spelling of spellings) {
			expect(select({ LATTICE_EMBED_MODEL: spelling }).model).toBe(
				"all-minilm-l6-v2-384",
			);
		}
	});

	test("a matryoshka model reports its truncated dimension", () => {
		const provider = select({
			LATTICE_EMBED_MODEL: "nomic-embed-text-v1.5",
		});

		expect(provider.model).toBe("nomic-embed-text-v1.5-512");
		expect(provider.dim).toBe(512);
		expect(provider.source).toBe("LATTICE_EMBED_MODEL");
	});

	test("an unknown model names the ones that exist", () => {
		expect(() => select({ LATTICE_EMBED_MODEL: "gpt-4" })).toThrow(
			/all-minilm-l6-v2/,
		);
	});

	test("the deterministic provider is still selectable", () => {
		const provider = select({ LATTICE_EMBED_PROVIDER: "hash" });

		expect(provider.model).toBe("hash-512");
	});
});
