import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { GraphService } from "../graph/graph.service.js";
import { DatabaseChangeDetectorService } from "./database-change-detector.service.js";

describe("DatabaseChangeDetectorService", () => {
	let service: DatabaseChangeDetectorService;
	let mockGraphService: Partial<GraphService>;

	beforeEach(() => {
		mockGraphService = {
			loadAllDocumentHashes: mock(async () => {
				return new Map([
					[
						"docs/existing.md",
						{
							contentHash: "abc123",
							embeddingSourceHash: "embed456",
						},
					],
					[
						"docs/no-embedding.md",
						{
							contentHash: "def789",
							embeddingSourceHash: null,
						},
					],
					[
						"docs/legacy.md",
						{
							contentHash: null,
							embeddingSourceHash: null,
						},
					],
				]);
			}),
		};

		service = new DatabaseChangeDetectorService(
			mockGraphService as GraphService,
		);
	});

	describe("loadHashes", () => {
		it("should load hashes from graph service", async () => {
			await service.loadHashes();

			expect(mockGraphService.loadAllDocumentHashes).toHaveBeenCalledTimes(1);
			expect(service.isLoaded()).toBe(true);
			expect(service.getCacheSize()).toBe(3);
		});

		it("should mark as loaded after successful load", async () => {
			expect(service.isLoaded()).toBe(false);
			await service.loadHashes();
			expect(service.isLoaded()).toBe(true);
		});
	});

	describe("reset", () => {
		it("should clear the cache and set loaded to false", async () => {
			await service.loadHashes();
			expect(service.isLoaded()).toBe(true);

			service.reset();
			expect(service.isLoaded()).toBe(false);
			expect(service.getCacheSize()).toBe(0);
		});
	});

	describe("getContentHash", () => {
		it("should return consistent SHA256 hash", () => {
			const content = "test content";
			const hash1 = service.getContentHash(content);
			const hash2 = service.getContentHash(content);

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64); // SHA256 hex length
		});

		it("should return different hashes for different content", () => {
			const hash1 = service.getContentHash("content1");
			const hash2 = service.getContentHash("content2");

			expect(hash1).not.toBe(hash2);
		});
	});

	describe("detectChange", () => {
		it("should throw if hashes not loaded", () => {
			expect(() => service.detectChange("docs/test.md", "hash")).toThrow(
				"Hashes not loaded",
			);
		});

		it("should return 'new' for unknown paths", async () => {
			await service.loadHashes();

			const result = service.detectChange("docs/new.md", "somehash");
			expect(result).toBe("new");
		});

		it("should return 'unchanged' for matching hash", async () => {
			await service.loadHashes();

			const result = service.detectChange("docs/existing.md", "abc123");
			expect(result).toBe("unchanged");
		});

		it("should return 'updated' for different hash", async () => {
			await service.loadHashes();

			const result = service.detectChange("docs/existing.md", "different");
			expect(result).toBe("updated");
		});

		it("should return 'updated' for legacy documents with null content hash", async () => {
			await service.loadHashes();

			const result = service.detectChange("docs/legacy.md", "anyhash");
			expect(result).toBe("updated");
		});
	});

	describe("detectChangeWithReason", () => {
		it("should return change type with reason", async () => {
			await service.loadHashes();

			const newDoc = service.detectChangeWithReason("docs/new.md", "hash");
			expect(newDoc.changeType).toBe("new");
			expect(newDoc.reason).toContain("not in database");

			const unchanged = service.detectChangeWithReason(
				"docs/existing.md",
				"abc123",
			);
			expect(unchanged.changeType).toBe("unchanged");
			expect(unchanged.reason).toContain("unchanged");

			const updated = service.detectChangeWithReason(
				"docs/existing.md",
				"different",
			);
			expect(updated.changeType).toBe("updated");
			expect(updated.reason).toContain("hash changed");
		});
	});

	describe("getTrackedPaths", () => {
		it("should throw if hashes not loaded", () => {
			expect(() => service.getTrackedPaths()).toThrow("Hashes not loaded");
		});

		it("should return all tracked paths", async () => {
			await service.loadHashes();

			const paths = service.getTrackedPaths();
			expect(paths).toHaveLength(3);
			expect(paths).toContain("docs/existing.md");
			expect(paths).toContain("docs/no-embedding.md");
			expect(paths).toContain("docs/legacy.md");
		});
	});

	describe("isEmbeddingStale", () => {
		it("should throw if hashes not loaded", () => {
			expect(() => service.isEmbeddingStale("docs/test.md", "hash")).toThrow(
				"Hashes not loaded",
			);
		});

		it("should return true for new documents", async () => {
			await service.loadHashes();

			const result = service.isEmbeddingStale("docs/new.md", "hash");
			expect(result).toBe(true);
		});

		it("should return true for documents without embedding hash", async () => {
			await service.loadHashes();

			const result = service.isEmbeddingStale("docs/no-embedding.md", "hash");
			expect(result).toBe(true);
		});

		it("should return true when embedding source changed", async () => {
			await service.loadHashes();

			const result = service.isEmbeddingStale("docs/existing.md", "different");
			expect(result).toBe(true);
		});

		it("should return false when embedding source unchanged", async () => {
			await service.loadHashes();

			const result = service.isEmbeddingStale("docs/existing.md", "embed456");
			expect(result).toBe(false);
		});
	});

	describe("getCachedEntry", () => {
		it("should throw if hashes not loaded", () => {
			expect(() => service.getCachedEntry("docs/test.md")).toThrow(
				"Hashes not loaded",
			);
		});

		it("should return cached entry for known path", async () => {
			await service.loadHashes();

			const entry = service.getCachedEntry("docs/existing.md");
			expect(entry).toEqual({
				contentHash: "abc123",
				embeddingSourceHash: "embed456",
			});
		});

		it("should return undefined for unknown path", async () => {
			await service.loadHashes();

			const entry = service.getCachedEntry("docs/unknown.md");
			expect(entry).toBeUndefined();
		});
	});

	describe("findDocumentsNeedingEmbeddings", () => {
		it("should throw if hashes not loaded", () => {
			expect(() => service.findDocumentsNeedingEmbeddings()).toThrow(
				"Hashes not loaded",
			);
		});

		it("should return documents without embedding source hash", async () => {
			await service.loadHashes();

			const needsEmbedding = service.findDocumentsNeedingEmbeddings();
			expect(needsEmbedding).toHaveLength(2);
			expect(needsEmbedding).toContain("docs/no-embedding.md");
			expect(needsEmbedding).toContain("docs/legacy.md");
			expect(needsEmbedding).not.toContain("docs/existing.md");
		});
	});
});
