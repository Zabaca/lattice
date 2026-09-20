import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalModelName,
	documentText,
	queryText,
	resolveModelChoice,
	resolveModelSource,
	truncateAndRenormalize,
} from "./provider.js";

/**
 * The `EmbeddingProvider` seam: what a model is called, what it is asked for,
 * and what shape its vectors come back in. Everything here is driven through
 * the public exports of `provider.ts`; nothing reaches into the registry.
 */
describe("model name normalisation", () => {
	test("a cosmetic difference in how a name is written is the same model", () => {
		const canonical = "nomic-embed-text-v1.5";

		for (const written of [
			"nomic-embed-text-v1.5",
			"  nomic-embed-text-v1.5  ",
			"Nomic-Embed-Text-v1.5",
			"nomic-ai/nomic-embed-text-v1.5",
			"hf.co/nomic-ai/nomic-embed-text-v1.5",
			"nomic-embed-text-v1.5:latest",
		]) {
			expect(canonicalModelName(written)).toBe(canonical);
		}
	});

	test("two genuinely different models do not normalise together", () => {
		expect(canonicalModelName("bge-small-en-v1.5")).not.toBe(
			canonicalModelName("nomic-embed-text-v1.5"),
		);
	});
});

describe("choosing a model", () => {
	test("with nothing set, the default model is chosen and says so", () => {
		const choice = resolveModelChoice({});

		// The default and its dimension are the ticket's decision, not the
		// registry's: 512 from a model whose native width is 768.
		expect(choice.model.name).toBe("nomic-embed-text-v1.5");
		expect(choice.dim).toBe(512);
		expect(choice.source).toBe("the built-in default");
	});

	test("LATTICE_EMBED_MODEL selects another model and is named as the source", () => {
		const choice = resolveModelChoice({
			LATTICE_EMBED_MODEL: "Xenova/bge-small-en-v1.5",
		});

		expect(choice.model.name).toBe("bge-small-en-v1.5");
		expect(choice.dim).toBe(384);
		expect(choice.source).toBe("LATTICE_EMBED_MODEL");
	});

	test("a cosmetically different spelling resolves to the same recorded model", () => {
		// What gets written into the index is the canonical name, so the two
		// spellings are the same space and no model change is triggered.
		const plain = resolveModelChoice({
			LATTICE_EMBED_MODEL: "nomic-embed-text-v1.5",
		});
		const dressed = resolveModelChoice({
			LATTICE_EMBED_MODEL: "hf.co/Nomic-AI/nomic-embed-text-v1.5:latest",
		});

		expect(dressed.model.name).toBe(plain.model.name);
		expect(dressed.dim).toBe(plain.dim);
	});

	test("an unregistered model is an error that lists what is registered", () => {
		expect(() =>
			resolveModelChoice({ LATTICE_EMBED_MODEL: "text-embedding-3-small" }),
		).toThrow(/text-embedding-3-small[\s\S]*nomic-embed-text-v1\.5/);
	});

	test("a truncatable model honours a smaller LATTICE_EMBED_DIM", () => {
		const choice = resolveModelChoice({ LATTICE_EMBED_DIM: "256" });

		expect(choice.dim).toBe(256);
		// The width is the thing the user changed, so it is the thing the
		// model-change message has to name.
		expect(choice.source).toBe("LATTICE_EMBED_DIM");
	});

	test("both variables set are both named as the source", () => {
		const choice = resolveModelChoice({
			LATTICE_EMBED_MODEL: "nomic-embed-text-v1.5",
			LATTICE_EMBED_DIM: "256",
		});

		expect(choice.source).toBe("LATTICE_EMBED_MODEL and LATTICE_EMBED_DIM");
	});

	test("a model that was not trained for truncation refuses a smaller dimension", () => {
		expect(() =>
			resolveModelChoice({
				LATTICE_EMBED_MODEL: "bge-small-en-v1.5",
				LATTICE_EMBED_DIM: "256",
			}),
		).toThrow(/bge-small-en-v1\.5/);
	});

	test("no model can be widened beyond what it emits", () => {
		expect(() => resolveModelChoice({ LATTICE_EMBED_DIM: "1024" })).toThrow(
			/768/,
		);
	});
});

describe("the prefixes a model was trained to expect", () => {
	test("nomic distinguishes a passage from a question", () => {
		const { model } = resolveModelChoice({});

		// Nomic's own model card: `search_document:` for what is indexed,
		// `search_query:` for what is asked.
		expect(documentText(model, "The cat sat on the mat.")).toBe(
			"search_document: The cat sat on the mat.",
		);
		expect(queryText(model, "where did the cat sit")).toBe(
			"search_query: where did the cat sit",
		);
	});

	test("bge prefixes only the query, and leaves passages alone", () => {
		const { model } = resolveModelChoice({
			LATTICE_EMBED_MODEL: "bge-small-en-v1.5",
		});

		expect(documentText(model, "The cat sat on the mat.")).toBe(
			"The cat sat on the mat.",
		);
		expect(queryText(model, "where did the cat sit")).toBe(
			"Represent this sentence for searching relevant passages: where did the cat sit",
		);
	});
});

describe("truncating a vector", () => {
	test("keeps the leading components and restores unit length", () => {
		// A worked example: (3, 4, 12) has length 13; its first two components
		// form a 3-4-5 triangle, so truncating to two and renormalising gives
		// (0.6, 0.8).
		const truncated = truncateAndRenormalize(
			new Float32Array([3 / 13, 4 / 13, 12 / 13]),
			2,
		);

		expect(truncated.length).toBe(2);
		expect(truncated[0]).toBeCloseTo(0.6, 6);
		expect(truncated[1]).toBeCloseTo(0.8, 6);
	});

	test("a vector already at the asked-for width is left as it is", () => {
		const vector = new Float32Array([0.6, 0.8]);

		const kept = truncateAndRenormalize(vector, 2);

		expect(kept.length).toBe(2);
		expect(kept[0]).toBeCloseTo(0.6, 6);
		expect(kept[1]).toBeCloseTo(0.8, 6);
	});
});

describe("where the model comes from", () => {
	/** A model cache holding every file the loader needs, and nothing else. */
	function placeModel(dir: string, repo: string): void {
		const target = join(dir, repo);
		mkdirSync(join(target, "onnx"), { recursive: true });
		for (const file of [
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
		]) {
			writeFileSync(join(target, file), "{}");
		}
		writeFileSync(join(target, "onnx", "model_quantized.onnx"), "");
	}

	test("with nothing cached, the model is downloaded into the Lattice home", () => {
		const home = mkdtempSync(join(tmpdir(), "lattice-model-"));

		const source = resolveModelSource({ LATTICE_HOME: home });

		expect(source.cacheDir).toBe(join(home, "models"));
		expect(source.allowRemote).toBe(true);
	});

	test("a model already in the cache is used with no download allowed", () => {
		const home = mkdtempSync(join(tmpdir(), "lattice-model-"));
		const { model } = resolveModelChoice({});
		placeModel(join(home, "models"), model.repo);

		const source = resolveModelSource({ LATTICE_HOME: home });

		expect(source.allowRemote).toBe(false);
	});

	test("LATTICE_MODEL_DIR is where a pre-placed model is looked for", () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "lattice-models-"));
		const { model } = resolveModelChoice({});
		placeModel(elsewhere, model.repo);

		const source = resolveModelSource({
			LATTICE_HOME: mkdtempSync(join(tmpdir(), "lattice-model-")),
			LATTICE_MODEL_DIR: elsewhere,
		});

		expect(source.cacheDir).toBe(elsewhere);
		expect(source.allowRemote).toBe(false);
	});

	test("offline with nothing cached is an error that says where to put it", () => {
		const home = mkdtempSync(join(tmpdir(), "lattice-model-"));

		// Either variable forbids it: Lattice's own, and the one the rest of
		// the ecosystem already sets.
		for (const offline of ["LATTICE_OFFLINE", "HF_HUB_OFFLINE"]) {
			expect(() =>
				resolveModelSource({ LATTICE_HOME: home, [offline]: "1" }),
			).toThrow(join(home, "models"));
		}
	});

	test("offline with the model cached is fine, and stays offline", () => {
		const home = mkdtempSync(join(tmpdir(), "lattice-model-"));
		const { model } = resolveModelChoice({});
		placeModel(join(home, "models"), model.repo);

		const source = resolveModelSource({
			LATTICE_HOME: home,
			LATTICE_OFFLINE: "1",
		});

		expect(source.allowRemote).toBe(false);
	});

	test("a mirror redirects where a download comes from", () => {
		const home = mkdtempSync(join(tmpdir(), "lattice-model-"));

		expect(
			resolveModelSource({
				LATTICE_HOME: home,
				LATTICE_HF_MIRROR: "https://mirror.example/",
			}).host,
		).toBe("https://mirror.example/");
		expect(
			resolveModelSource({
				LATTICE_HOME: home,
				HF_ENDPOINT: "https://endpoint.example/",
			}).host,
		).toBe("https://endpoint.example/");
	});
});
