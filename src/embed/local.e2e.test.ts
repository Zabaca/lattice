/**
 * The one test that uses the real thing.
 *
 * It downloads models from Hugging Face and runs them, which is slow and
 * needs a network, so it is skipped unless `LATTICE_E2E_MODEL=1` is set:
 *
 *     LATTICE_E2E_MODEL=1 bun test
 *
 * Everything else in the suite runs against the deterministic provider. This
 * is the only place that can catch a registry entry that is wrong about a
 * real model — the pooling, the prefixes, the dimensions.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/run.js";
import { selectProvider } from "./provider.js";

const ENABLED = process.env.LATTICE_E2E_MODEL === "1";

/**
 * One home shared by the whole block: the download is the expensive part and
 * caching it is exactly the behavior under test.
 */
const HOME = ENABLED ? mkdtempSync(join(tmpdir(), "lattice-e2e-")) : "";

function norm(vector: Float32Array): number {
	let total = 0;
	for (const component of vector) {
		total += component * component;
	}
	return Math.sqrt(total);
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
	}
	return dot / (norm(a) * norm(b));
}

describe.skipIf(!ENABLED)("the real local model", () => {
	test("init downloads it once, and a later sync works offline", async () => {
		const first = await runCli({ argv: ["init"], env: { LATTICE_HOME: HOME } });

		expect(first.code).toBe(0);
		expect(first.stdout).toContain("all-minilm-l6-v2-384");
		expect(first.stdout).toContain("downloaded");
		expect(existsSync(join(HOME, "models"))).toBe(true);

		// Cached: a second init has nothing to fetch and says so.
		const second = await runCli({
			argv: ["init"],
			env: { LATTICE_HOME: HOME },
		});

		expect(second.stdout).toContain("already cached");
		expect(second.stdout).not.toContain("downloaded");

		// And with the hub forbidden entirely, the index still builds.
		await Bun.write(
			join(HOME, "docs", "chunking.md"),
			"---\ntype: Guide\ntitle: Chunking\n---\n\n# Chunking\n\nDocuments are split at headings.\n",
		);
		const synced = await runCli({
			argv: ["sync"],
			env: { LATTICE_HOME: HOME, HF_HUB_OFFLINE: "1" },
		});

		expect(synced.code).toBe(0);
		expect(synced.stdout).toContain("with all-minilm-l6-v2-384");
		expect(synced.stdout).toContain("Embedded 1 chunk");
	}, 600_000);

	test("a pre-placed model directory is used instead of the hub", async () => {
		// Someone who cannot reach Hugging Face copies the directory in by
		// hand. Nothing else about the run changes.
		const placed = mkdtempSync(join(tmpdir(), "lattice-placed-"));
		cpSync(join(HOME, "models"), placed, { recursive: true });

		const home = mkdtempSync(join(tmpdir(), "lattice-e2e-placed-"));
		const env = { LATTICE_HOME: home, LATTICE_MODEL_DIR: placed };
		await runCli({ argv: ["init"], env });
		await Bun.write(
			join(home, "docs", "chunking.md"),
			"---\ntype: Guide\ntitle: Chunking\n---\n\n# Chunking\n\nDocuments are split at headings.\n",
		);

		const synced = await runCli({ argv: ["sync"], env });

		expect(synced.code).toBe(0);
		expect(synced.stdout).toContain("Embedded 1 chunk");
		// Nothing was fetched: the home's own cache is still empty.
		expect(existsSync(join(home, "models", "Xenova"))).toBe(false);
	}, 600_000);

	test("the default model embeds at its native dimension and ranks sensibly", async () => {
		const provider = selectProvider({ LATTICE_HOME: HOME });
		const [about, unrelated] = await provider.embed([
			"Documents are split into passages at their headings.",
			"The kettle boiled while the cat slept on the windowsill.",
		]);
		const query = await provider.embedQuery(
			"how is a document divided into chunks?",
		);

		// Not matryoshka: nothing is truncated away from its 384.
		expect(about.length).toBe(384);
		expect(norm(about)).toBeCloseTo(1, 4);

		// MiniLM asks for no prefixes, so a query is embedded as its text is.
		const [plain] = await provider.embed([
			"how is a document divided into chunks?",
		]);
		expect(cosine(query, plain)).toBeCloseTo(1, 5);

		expect(cosine(query, about)).toBeGreaterThan(cosine(query, unrelated));
	}, 600_000);

	test("a matryoshka model is truncated and re-normalised, and is prefixed", async () => {
		const provider = selectProvider({
			LATTICE_HOME: HOME,
			LATTICE_EMBED_MODEL: "nomic-embed-text-v1.5",
		});
		const text = "Documents are split into passages at their headings.";
		const [document] = await provider.embed([text]);
		const query = await provider.embedQuery(text);

		// 512 of the model's native 768, re-normalised after the cut.
		expect(provider.dim).toBe(512);
		expect(document.length).toBe(512);
		expect(norm(document)).toBeCloseTo(1, 4);

		// The same words, but nomic is told which side they are on, so the
		// two vectors must not be the same one.
		expect(cosine(document, query)).toBeLessThan(0.999);
	}, 600_000);
});
