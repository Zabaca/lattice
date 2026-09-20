import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectProvider } from "./provider.js";

/**
 * The one test that runs the real model.
 *
 * It downloads about 145 MB the first time and takes seconds rather than
 * milliseconds, so it is skipped unless it is asked for:
 *
 *   LATTICE_E2E_MODEL=1 bun test src/embed/local.e2e.test.ts
 *
 * Set LATTICE_MODEL_DIR to reuse a model cache you already have.
 */
const enabled = Boolean(process.env.LATTICE_E2E_MODEL);

/** Both vectors are unit length, so a dot product is a cosine similarity. */
function similarity(a: Float32Array, b: Float32Array): number {
	let total = 0;
	for (let i = 0; i < a.length; i++) {
		total += a[i] * b[i];
	}
	return total;
}

describe.skipIf(!enabled)("the real local model", () => {
	const provider = selectProvider({
		LATTICE_EMBED_PROVIDER: "local",
		LATTICE_HOME: mkdtempSync(join(tmpdir(), "lattice-e2e-")),
		LATTICE_MODEL_DIR: process.env.LATTICE_MODEL_DIR,
	});

	test("embeds passages and questions into one space where meaning wins", async () => {
		const [orders, weather] = await provider.embed([
			"The orders table holds one row per completed purchase, keyed by order id.",
			"Fog is expected along the coast until late morning.",
		]);
		const [question] = await provider.embedQuery([
			"where do I find completed purchases",
		]);

		// The recorded space is what the index will be stamped with.
		expect(provider.model).toBe("nomic-embed-text-v1.5");
		expect(provider.dim).toBe(512);
		expect(orders.length).toBe(512);

		// Truncated and renormalised: still a unit vector.
		expect(similarity(orders, orders)).toBeCloseTo(1, 3);

		// The point of a real model: the passage about purchases is nearer to
		// the question than the one about the weather. A hash provider fails
		// this, which is why it is not the thing being tested here.
		expect(similarity(question, orders)).toBeGreaterThan(
			similarity(question, weather),
		);
	}, 600_000);
});
