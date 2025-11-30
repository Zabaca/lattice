import { beforeEach, describe, expect, it, mock } from "bun:test";
import { EmbeddingService } from "./embedding.service.js";
import { MockEmbeddingProvider } from "./providers/mock.provider.js";

// Mock ConfigService for testing
const createMockConfigService = (overrides: Record<string, unknown> = {}) => ({
	get: mock((key: string, defaultValue?: unknown) => {
		const config: Record<string, unknown> = {
			EMBEDDING_PROVIDER: "mock",
			EMBEDDING_DIMENSIONS: 1536,
			EMBEDDING_MODEL: "text-embedding-3-small",
			...overrides,
		};
		return config[key] ?? defaultValue;
	}),
});

type MockConfigService = ReturnType<typeof createMockConfigService>;

describe("EmbeddingService", () => {
	let service: EmbeddingService;
	let mockConfigService: MockConfigService;

	beforeEach(() => {
		mockConfigService = createMockConfigService();
		service = new EmbeddingService(mockConfigService);
	});

	describe("initialization", () => {
		it("should initialize with mock provider by default", () => {
			expect(service.getProviderName()).toBe("mock");
		});

		it("should have correct dimensions from config", () => {
			expect(service.getDimensions()).toBe(1536);
		});

		it("should identify as non-real provider when using mock", () => {
			expect(service.isRealProvider()).toBe(false);
		});

		it("should load configuration from ConfigService", () => {
			// The service should have initialized successfully
			// which means config was loaded properly
			const providerName = service.getProviderName();
			expect(providerName).toBeDefined();
			expect(typeof providerName).toBe("string");
		});

		it("should use custom dimensions when provided", () => {
			const mockConfig = createMockConfigService({
				EMBEDDING_PROVIDER: "mock",
				EMBEDDING_DIMENSIONS: 512,
			});
			const customService = new EmbeddingService(mockConfig);
			expect(customService.getDimensions()).toBe(512);
		});

		it("should throw error for providers without API key", () => {
			const mockConfig = createMockConfigService({
				EMBEDDING_PROVIDER: "voyage",
			});
			expect(() => new EmbeddingService(mockConfig)).toThrow(
				"VOYAGE_API_KEY environment variable is required",
			);
		});
	});

	describe("generateEmbedding", () => {
		it("should generate embedding with correct dimensions", async () => {
			const embedding = await service.generateEmbedding("test text");
			expect(embedding).toBeInstanceOf(Array);
			expect(embedding.length).toBe(1536);
		});

		it("should generate normalized embedding (magnitude ~1)", async () => {
			const embedding = await service.generateEmbedding("test text");
			const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
			// Should be very close to 1.0 (normalized vector)
			expect(magnitude).toBeCloseTo(1.0, 5);
		});

		it("should return deterministic embeddings for same input", async () => {
			const embedding1 = await service.generateEmbedding("hello world");
			const embedding2 = await service.generateEmbedding("hello world");
			expect(embedding1).toEqual(embedding2);
		});

		it("should return different embeddings for different inputs", async () => {
			const embedding1 = await service.generateEmbedding("hello");
			const embedding2 = await service.generateEmbedding("world");
			expect(embedding1).not.toEqual(embedding2);
		});

		it("should throw error for empty text", async () => {
			try {
				await service.generateEmbedding("");
				expect.unreachable("Should have thrown an error");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					"Cannot generate embedding for empty text",
				);
			}
		});

		it("should throw error for whitespace-only text", async () => {
			try {
				await service.generateEmbedding("   ");
				expect.unreachable("Should have thrown an error");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					"Cannot generate embedding for empty text",
				);
			}
		});

		it("should throw error for null text", async () => {
			try {
				await service.generateEmbedding(null as unknown as string);
				expect.unreachable("Should have thrown an error");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					"Cannot generate embedding for empty text",
				);
			}
		});

		it("should handle text with special characters", async () => {
			const specialText = "Hello @#$%^&*() World!";
			const embedding = await service.generateEmbedding(specialText);
			expect(embedding.length).toBe(1536);
			expect(embedding[0]).not.toBeNaN();
		});

		it("should handle long text", async () => {
			const longText = "a".repeat(10000);
			const embedding = await service.generateEmbedding(longText);
			expect(embedding.length).toBe(1536);
		});

		it("should handle unicode characters", async () => {
			const unicodeText = "你好世界 مرحبا بالعالم";
			const embedding = await service.generateEmbedding(unicodeText);
			expect(embedding.length).toBe(1536);
		});

		it("should handle single character", async () => {
			const embedding = await service.generateEmbedding("a");
			expect(embedding.length).toBe(1536);
		});
	});

	describe("generateEmbeddings (batch)", () => {
		it("should generate embeddings for multiple texts", async () => {
			const embeddings = await service.generateEmbeddings([
				"text1",
				"text2",
				"text3",
			]);
			expect(embeddings).toBeInstanceOf(Array);
			expect(embeddings.length).toBe(3);
			expect(embeddings[0].length).toBe(1536);
			expect(embeddings[1].length).toBe(1536);
			expect(embeddings[2].length).toBe(1536);
		});

		it("should filter out empty texts before processing", async () => {
			const embeddings = await service.generateEmbeddings([
				"text1",
				"",
				"text2",
			]);
			// Should only return 2 embeddings (empty text filtered out)
			expect(embeddings.length).toBe(2);
		});

		it("should filter out whitespace-only texts", async () => {
			const embeddings = await service.generateEmbeddings([
				"text1",
				"   ",
				"text2",
				"\t",
				"text3",
			]);
			// Should only return 3 embeddings (whitespace texts filtered out)
			expect(embeddings.length).toBe(3);
		});

		it("should return empty array for all empty texts", async () => {
			const embeddings = await service.generateEmbeddings(["", "  ", "", "\t"]);
			expect(embeddings).toEqual([]);
		});

		it("should return empty array for empty input array", async () => {
			const embeddings = await service.generateEmbeddings([]);
			expect(embeddings).toEqual([]);
		});

		it("should maintain order of embeddings", async () => {
			const texts = ["apple", "banana", "cherry"];
			const embeddings = await service.generateEmbeddings(texts);

			// Generate embeddings individually to compare order
			const individual = await Promise.all(
				texts.map((t) => service.generateEmbedding(t)),
			);

			expect(embeddings.length).toBe(individual.length);
			for (let i = 0; i < embeddings.length; i++) {
				expect(embeddings[i]).toEqual(individual[i]);
			}
		});

		it("should handle single text in batch", async () => {
			const embeddings = await service.generateEmbeddings(["single text"]);
			expect(embeddings.length).toBe(1);
			expect(embeddings[0].length).toBe(1536);
		});

		it("should handle large batch of texts", async () => {
			const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
			const embeddings = await service.generateEmbeddings(texts);
			expect(embeddings.length).toBe(100);
		});

		it("should handle batch with mixed valid and invalid texts", async () => {
			const embeddings = await service.generateEmbeddings([
				"valid1",
				"",
				"valid2",
				"   ",
				"valid3",
				"\n",
				"valid4",
			]);
			// Should only return 4 embeddings for valid texts
			expect(embeddings.length).toBe(4);
		});

		it("all generated embeddings should be normalized", async () => {
			const embeddings = await service.generateEmbeddings([
				"text1",
				"text2",
				"text3",
			]);
			for (const embedding of embeddings) {
				const magnitude = Math.sqrt(
					embedding.reduce((sum, v) => sum + v * v, 0),
				);
				expect(magnitude).toBeCloseTo(1.0, 5);
			}
		});
	});

	describe("provider selection", () => {
		it("should use mock provider when explicitly configured", () => {
			const mockConfig = createMockConfigService({
				EMBEDDING_PROVIDER: "mock",
			});
			const mockService = new EmbeddingService(mockConfig);
			expect(mockService.getProviderName()).toBe("mock");
			expect(mockService.isRealProvider()).toBe(false);
		});

		it("should handle default provider configuration", () => {
			const mockConfig = createMockConfigService({
				EMBEDDING_PROVIDER: "openai",
				OPENAI_API_KEY: "test-key-123",
			});
			const defaultService = new EmbeddingService(mockConfig);
			// Default provider is openai
			expect(defaultService.getProviderName()).toBe("openai");
			expect(defaultService.isRealProvider()).toBe(true);
		});

		it("should throw error when openai provider configured but no API key", () => {
			const mockConfig = createMockConfigService({
				EMBEDDING_PROVIDER: "openai",
				OPENAI_API_KEY: undefined,
			});
			// Should throw error when no API key
			expect(() => new EmbeddingService(mockConfig)).toThrow(
				"OPENAI_API_KEY environment variable is required",
			);
		});

		it("should throw error when openai provider configured with empty API key", () => {
			const mockConfig = createMockConfigService({
				EMBEDDING_PROVIDER: "openai",
				OPENAI_API_KEY: "",
			});
			// Empty string should also trigger error
			expect(() => new EmbeddingService(mockConfig)).toThrow(
				"OPENAI_API_KEY environment variable is required",
			);
		});
	});

	describe("embedding consistency", () => {
		it("should generate consistent embeddings across multiple calls", async () => {
			const text = "consistency test";
			const embeddings: number[][] = [];

			for (let i = 0; i < 5; i++) {
				const embedding = await service.generateEmbedding(text);
				embeddings.push(embedding);
			}

			// All embeddings should be identical
			for (let i = 1; i < embeddings.length; i++) {
				expect(embeddings[i]).toEqual(embeddings[0]);
			}
		});

		it("should maintain determinism in batch operations", async () => {
			const texts = ["test1", "test2", "test3"];
			const batch1 = await service.generateEmbeddings(texts);
			const batch2 = await service.generateEmbeddings(texts);

			expect(batch1.length).toBe(batch2.length);
			for (let i = 0; i < batch1.length; i++) {
				expect(batch1[i]).toEqual(batch2[i]);
			}
		});
	});

	describe("edge cases and error handling", () => {
		it("should handle text with newlines", async () => {
			const embedding = await service.generateEmbedding("line1\nline2\nline3");
			expect(embedding.length).toBe(1536);
		});

		it("should handle text with tabs", async () => {
			const embedding = await service.generateEmbedding("col1\tcol2\tcol3");
			expect(embedding.length).toBe(1536);
		});

		it("should handle text with multiple spaces", async () => {
			const embedding = await service.generateEmbedding("word1    word2");
			expect(embedding.length).toBe(1536);
		});

		it("should handle very long unicode strings", async () => {
			const longUnicode = "😀".repeat(1000);
			const embedding = await service.generateEmbedding(longUnicode);
			expect(embedding.length).toBe(1536);
		});

		it("should not modify the service state during embedding generation", async () => {
			const provider1 = service.getProviderName();
			const dims1 = service.getDimensions();

			await service.generateEmbedding("test1");
			await service.generateEmbeddings(["test2", "test3"]);

			const provider2 = service.getProviderName();
			const dims2 = service.getDimensions();

			expect(provider1).toBe(provider2);
			expect(dims1).toBe(dims2);
		});
	});
});

describe("MockEmbeddingProvider", () => {
	it("should support default dimensions", () => {
		const provider = new MockEmbeddingProvider();
		expect(provider.dimensions).toBe(1536);
	});

	it("should support custom dimensions", () => {
		const provider = new MockEmbeddingProvider(512);
		expect(provider.dimensions).toBe(512);
	});

	it("should generate embeddings with custom dimensions", async () => {
		const provider = new MockEmbeddingProvider(256);
		const embedding = await provider.generateEmbedding("test");
		expect(embedding.length).toBe(256);
	});

	it("should generate embeddings with different dimension sizes", async () => {
		const dimensions = [64, 256, 512, 1024, 1536];

		for (const dim of dimensions) {
			const provider = new MockEmbeddingProvider(dim);
			const embedding = await provider.generateEmbedding("test");
			expect(embedding.length).toBe(dim);
		}
	});

	it("should generate normalized embeddings", async () => {
		const provider = new MockEmbeddingProvider(512);
		const embedding = await provider.generateEmbedding("test");
		const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
		expect(magnitude).toBeCloseTo(1.0, 5);
	});

	it("should return deterministic embeddings", async () => {
		const provider = new MockEmbeddingProvider(256);
		const embedding1 = await provider.generateEmbedding("hello world");
		const embedding2 = await provider.generateEmbedding("hello world");
		expect(embedding1).toEqual(embedding2);
	});

	it("should return different embeddings for different texts", async () => {
		const provider = new MockEmbeddingProvider(256);
		const embedding1 = await provider.generateEmbedding("hello");
		const embedding2 = await provider.generateEmbedding("world");
		expect(embedding1).not.toEqual(embedding2);
	});

	it("should handle batch embeddings with custom dimensions", async () => {
		const provider = new MockEmbeddingProvider(512);
		const embeddings = await provider.generateEmbeddings([
			"text1",
			"text2",
			"text3",
		]);
		expect(embeddings.length).toBe(3);
		for (const embedding of embeddings) {
			expect(embedding.length).toBe(512);
		}
	});

	it("should handle empty batch", async () => {
		const provider = new MockEmbeddingProvider();
		const embeddings = await provider.generateEmbeddings([]);
		expect(embeddings).toEqual([]);
	});

	it("should have correct provider name", () => {
		const provider = new MockEmbeddingProvider();
		expect(provider.name).toBe("mock");
	});

	it("should generate valid numbers in embeddings", async () => {
		const provider = new MockEmbeddingProvider(256);
		const embedding = await provider.generateEmbedding("test");

		for (const value of embedding) {
			expect(typeof value).toBe("number");
			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(-1);
			expect(value).toBeLessThanOrEqual(1);
		}
	});
});
