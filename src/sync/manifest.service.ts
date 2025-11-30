import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Injectable } from "@nestjs/common";
import {
	type ManifestEntry,
	type SyncManifest,
	SyncManifestSchema,
} from "../schemas/manifest.schemas.js";

// Re-export types for backwards compatibility
export type { ManifestEntry, SyncManifest };

export type ChangeType = "new" | "updated" | "deleted" | "unchanged";

export interface DocumentChange {
	path: string;
	changeType: ChangeType;
	reason?: string;
}

/**
 * Get the project root from environment or default
 */
function getProjectRoot(): string {
	if (process.env.PROJECT_ROOT) {
		return process.env.PROJECT_ROOT;
	}
	return process.cwd();
}

@Injectable()
export class ManifestService {
	private manifestPath: string;
	private manifest: SyncManifest | null = null;

	constructor() {
		const docsPath = process.env.DOCS_PATH || "docs";
		this.manifestPath = resolve(
			getProjectRoot(),
			docsPath,
			".sync-manifest.json",
		);
	}

	/**
	 * Load manifest from disk or create empty one if it doesn't exist
	 * Validates manifest structure with Zod schema
	 */
	async load(): Promise<SyncManifest> {
		try {
			if (existsSync(this.manifestPath)) {
				const content = await readFile(this.manifestPath, "utf-8");
				// Validate manifest with Zod schema (fail-fast on invalid manifest)
				this.manifest = SyncManifestSchema.parse(JSON.parse(content));
			} else {
				this.manifest = this.createEmptyManifest();
			}
		} catch (_error) {
			// If parse fails or file doesn't exist, create empty manifest
			this.manifest = this.createEmptyManifest();
		}

		return this.manifest;
	}

	/**
	 * Save manifest to disk
	 */
	async save(): Promise<void> {
		if (!this.manifest) {
			throw new Error("Manifest not loaded. Call load() first.");
		}

		this.manifest.lastSync = new Date().toISOString();

		const content = JSON.stringify(this.manifest, null, 2);
		await writeFile(this.manifestPath, content, "utf-8");
	}

	/**
	 * Get SHA256 hash for content
	 */
	getContentHash(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}

	/**
	 * Detect change type for a document
	 */
	detectChange(
		path: string,
		contentHash: string,
		frontmatterHash: string,
	): ChangeType {
		if (!this.manifest) {
			throw new Error("Manifest not loaded. Call load() first.");
		}

		const existing = this.manifest.documents[path];

		if (!existing) {
			return "new";
		}

		if (
			existing.contentHash === contentHash &&
			existing.frontmatterHash === frontmatterHash
		) {
			return "unchanged";
		}

		return "updated";
	}

	/**
	 * Update manifest entry after sync
	 */
	updateEntry(
		path: string,
		contentHash: string,
		frontmatterHash: string,
		entityCount: number,
		relationshipCount: number,
	): void {
		if (!this.manifest) {
			throw new Error("Manifest not loaded. Call load() first.");
		}

		this.manifest.documents[path] = {
			contentHash,
			frontmatterHash,
			lastSynced: new Date().toISOString(),
			entityCount,
			relationshipCount,
		};
	}

	/**
	 * Remove entry from manifest (for deleted docs)
	 */
	removeEntry(path: string): void {
		if (!this.manifest) {
			throw new Error("Manifest not loaded. Call load() first.");
		}

		delete this.manifest.documents[path];
	}

	/**
	 * Get all paths in manifest (to detect deletions)
	 */
	getTrackedPaths(): string[] {
		if (!this.manifest) {
			throw new Error("Manifest not loaded. Call load() first.");
		}

		return Object.keys(this.manifest.documents);
	}

	/**
	 * Initialize empty manifest
	 */
	private createEmptyManifest(): SyncManifest {
		return {
			version: "1.0",
			lastSync: new Date().toISOString(),
			documents: {},
		};
	}
}
