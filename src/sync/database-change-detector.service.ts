import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { GraphService } from "../graph/graph.service.js";

export type ChangeType = "new" | "updated" | "deleted" | "unchanged";

export interface DocumentChange {
	path: string;
	changeType: ChangeType;
	reason?: string;
}

interface HashEntry {
	contentHash: string | null;
	embeddingSourceHash: string | null;
}

/**
 * Database-driven change detection service.
 * Replaces ManifestService for v2 architecture.
 *
 * Uses batch loading pattern:
 * 1. Load ALL document hashes in ONE query at sync start
 * 2. Perform all change detection via in-memory Map lookups (O(1))
 * 3. No per-file DB queries during detection phase
 */
@Injectable()
export class DatabaseChangeDetectorService {
	private readonly logger = new Logger(DatabaseChangeDetectorService.name);
	private hashCache: Map<string, HashEntry> = new Map();
	private loaded = false;

	constructor(private readonly graph: GraphService) {}

	/**
	 * Load ALL document hashes in ONE query at sync start.
	 * Must be called before any detectChange() or other lookup operations.
	 */
	async loadHashes(): Promise<void> {
		this.hashCache = await this.graph.loadAllDocumentHashes();
		this.loaded = true;
		this.logger.debug(`Loaded ${this.hashCache.size} document hashes from DB`);
	}

	/**
	 * Check if hashes have been loaded.
	 */
	isLoaded(): boolean {
		return this.loaded;
	}

	/**
	 * Reset cache (useful for testing or reloading).
	 */
	reset(): void {
		this.hashCache.clear();
		this.loaded = false;
	}

	/**
	 * Get SHA256 hash for content.
	 */
	getContentHash(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}

	/**
	 * Detect change type for a document - O(1) in-memory lookup.
	 * No DB call - uses cached hashes from loadHashes().
	 *
	 * @param path - Document path
	 * @param currentContentHash - Hash of current file content
	 * @returns ChangeType indicating if document is new, updated, or unchanged
	 */
	detectChange(path: string, currentContentHash: string): ChangeType {
		if (!this.loaded) {
			throw new Error(
				"Hashes not loaded. Call loadHashes() before detectChange().",
			);
		}

		const cached = this.hashCache.get(path);

		if (!cached) {
			return "new";
		}

		// If no content hash stored (legacy document), treat as updated
		if (!cached.contentHash) {
			return "updated";
		}

		return cached.contentHash === currentContentHash ? "unchanged" : "updated";
	}

	/**
	 * Detect change with reason for logging/debugging.
	 */
	detectChangeWithReason(
		path: string,
		currentContentHash: string,
	): DocumentChange {
		const changeType = this.detectChange(path, currentContentHash);

		let reason: string;
		switch (changeType) {
			case "new":
				reason = "New document not in database";
				break;
			case "updated":
				reason = "Content hash changed";
				break;
			case "unchanged":
				reason = "Content unchanged";
				break;
			default:
				reason = "Unknown";
		}

		return { path, changeType, reason };
	}

	/**
	 * Get all paths tracked in the database.
	 * Used for detecting deleted documents.
	 *
	 * @returns Array of document paths from cache
	 */
	getTrackedPaths(): string[] {
		if (!this.loaded) {
			throw new Error(
				"Hashes not loaded. Call loadHashes() before getTrackedPaths().",
			);
		}

		return Array.from(this.hashCache.keys());
	}

	/**
	 * Check if a document's embedding is stale (needs regeneration).
	 *
	 * @param path - Document path
	 * @param currentSourceHash - Hash of current embedding source text
	 * @returns true if embedding needs regeneration
	 */
	isEmbeddingStale(path: string, currentSourceHash: string): boolean {
		if (!this.loaded) {
			throw new Error(
				"Hashes not loaded. Call loadHashes() before isEmbeddingStale().",
			);
		}

		const cached = this.hashCache.get(path);

		// No cached entry or no embedding source hash = needs generation
		if (!cached?.embeddingSourceHash) {
			return true;
		}

		return cached.embeddingSourceHash !== currentSourceHash;
	}

	/**
	 * Get the cached hash entry for a document.
	 * Useful for debugging or advanced scenarios.
	 */
	getCachedEntry(path: string): HashEntry | undefined {
		if (!this.loaded) {
			throw new Error(
				"Hashes not loaded. Call loadHashes() before getCachedEntry().",
			);
		}

		return this.hashCache.get(path);
	}

	/**
	 * Get the number of documents in the cache.
	 */
	getCacheSize(): number {
		return this.hashCache.size;
	}

	/**
	 * Find documents that need embedding generation.
	 * Returns paths where embeddingSourceHash is null or missing.
	 */
	findDocumentsNeedingEmbeddings(): string[] {
		if (!this.loaded) {
			throw new Error(
				"Hashes not loaded. Call loadHashes() before findDocumentsNeedingEmbeddings().",
			);
		}

		const needsEmbedding: string[] = [];

		for (const [path, entry] of this.hashCache) {
			if (!entry.embeddingSourceHash) {
				needsEmbedding.push(path);
			}
		}

		return needsEmbedding;
	}
}
