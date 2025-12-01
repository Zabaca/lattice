import { beforeEach, describe, expect, it } from "bun:test";
import { ConfigService } from "@nestjs/config";
import { EmbeddingService } from "./embedding.service.js";

// Real ConfigService with test configuration
const createConfigService = (): ConfigService =>
	new ConfigService({
		EMBEDDING_PROVIDER: "mock",
		EMBEDDING_DIMENSIONS: 1536,
		EMBEDDING_MODEL: "text-embedding-3-small",
	});

describe("EmbeddingService", () => {
	let service: EmbeddingService;

	beforeEach(() => {
		service = new EmbeddingService(createConfigService());
	});

	describe("generateEmbedding", () => {
		it("returns embedding with correct dimensions", async () => {
			const embedding = await service.generateEmbedding("test text");

			expect(embedding).toBeInstanceOf(Array);
			expect(embedding.length).toBe(1536);
		});

		it("returns normalized embedding (magnitude ≈ 1)", async () => {
			const embedding = await service.generateEmbedding("test text");

			const magnitude = Math.sqrt(
				embedding.reduce((sum, v) => sum + v * v, 0),
			);
			expect(magnitude).toBeCloseTo(1.0, 5);
		});

		it("is deterministic for same input", async () => {
			const embedding1 = await service.generateEmbedding("hello world");
			const embedding2 = await service.generateEmbedding("hello world");

			expect(embedding1).toEqual(embedding2);
		});

		it("returns different embeddings for different inputs", async () => {
			const embedding1 = await service.generateEmbedding("hello");
			const embedding2 = await service.generateEmbedding("world");

			expect(embedding1).not.toEqual(embedding2);
		});

		it("throws for empty text", async () => {
			await expect(service.generateEmbedding("")).rejects.toThrow(
				"Cannot generate embedding for empty text",
			);
		});

		it("throws for whitespace-only text", async () => {
			await expect(service.generateEmbedding("   ")).rejects.toThrow(
				"Cannot generate embedding for empty text",
			);
		});
	});

	describe("generateEmbeddings (batch)", () => {
		it("returns embeddings for multiple texts", async () => {
			const embeddings = await service.generateEmbeddings([
				"text1",
				"text2",
				"text3",
			]);

			expect(embeddings.length).toBe(3);
			expect(embeddings[0].length).toBe(1536);
			expect(embeddings[1].length).toBe(1536);
			expect(embeddings[2].length).toBe(1536);
		});

		it("filters out empty texts", async () => {
			const embeddings = await service.generateEmbeddings([
				"valid1",
				"",
				"valid2",
				"   ",
				"valid3",
			]);

			expect(embeddings.length).toBe(3);
		});

		it("returns empty array for all-empty input", async () => {
			const embeddings = await service.generateEmbeddings(["", "  ", "\t"]);

			expect(embeddings).toEqual([]);
		});

		it("returns empty array for empty input array", async () => {
			const embeddings = await service.generateEmbeddings([]);

			expect(embeddings).toEqual([]);
		});
	});
});
