import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Injectable, Logger } from "@nestjs/common";
import { glob } from "glob";
import type { Entity, Relationship } from "../utils/frontmatter.js";
import {
	type GraphMetadata,
	GraphMetadataSchema,
	parseFrontmatter,
} from "../utils/frontmatter.js";
import {
	ensureLatticeHome,
	getDocsPath as getLatticeDocsPath,
} from "../utils/paths.js";

export interface ParsedDocument {
	path: string;
	title: string;
	content: string;
	contentHash: string;
	frontmatterHash: string;
	summary?: string;
	topic?: string;
	embedding?: number[];
	entities: Entity[];
	relationships: Relationship[];
	graphMetadata?: GraphMetadata;
	tags: string[];
	created?: string;
	updated?: string;
	status?: string;
}

@Injectable()
export class DocumentParserService {
	private readonly logger = new Logger(DocumentParserService.name);
	private docsPath: string;

	constructor() {
		ensureLatticeHome();
		this.docsPath = getLatticeDocsPath();
	}

	/**
	 * Get the configured docs path (absolute)
	 */
	getDocsPath(): string {
		return this.docsPath;
	}

	/**
	 * Discover all markdown files in docs directory
	 */
	async discoverDocuments(): Promise<string[]> {
		const pattern = `${this.docsPath}/**/*.md`;
		const files = await glob(pattern, {
			ignore: ["**/node_modules/**", "**/.git/**"],
		});
		return files.sort();
	}

	/**
	 * Parse a single document.
	 *
	 * NOTE: In v2, entities and relationships are extracted via AI (EntityExtractorService),
	 * not from frontmatter. This method returns empty arrays for these fields.
	 * The summary field may be populated from frontmatter if present, but AI-generated
	 * summaries from EntityExtractorService should be preferred.
	 */
	async parseDocument(filePath: string): Promise<ParsedDocument> {
		const content = await readFile(filePath, "utf-8");
		const parsed = parseFrontmatter(content);

		// Extract title from first H1 or filename
		const title = this.extractTitle(content, filePath);

		// Compute hashes
		const contentHash = this.computeHash(content);
		const frontmatterHash = this.computeHash(
			JSON.stringify(parsed.frontmatter || {}),
		);

		// Extract graph metadata (still useful for domain hints)
		const graphMetadata = this.extractGraphMetadata(parsed.frontmatter);

		// v2: Entities and relationships come from AI extraction, not frontmatter
		// Frontmatter entities/relationships are ignored
		return {
			path: filePath,
			title,
			content: parsed.content,
			contentHash,
			frontmatterHash,
			summary: parsed.frontmatter?.summary, // May be overridden by AI extraction
			topic: parsed.frontmatter?.topic,
			entities: [], // v2: Always empty - filled by EntityExtractorService
			relationships: [], // v2: Always empty - filled by EntityExtractorService
			graphMetadata,
			tags: parsed.frontmatter?.tags || [],
			created: parsed.frontmatter?.created,
			updated: parsed.frontmatter?.updated,
			status: parsed.frontmatter?.status,
		};
	}

	/**
	 * Parse all documents
	 */
	async parseAllDocuments(): Promise<ParsedDocument[]> {
		const { docs } = await this.parseAllDocumentsWithErrors();
		return docs;
	}

	/**
	 * Parse all documents and collect errors (for validation)
	 */
	async parseAllDocumentsWithErrors(): Promise<{
		docs: ParsedDocument[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const files = await this.discoverDocuments();
		const docs: ParsedDocument[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const file of files) {
			try {
				const parsed = await this.parseDocument(file);
				docs.push(parsed);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				errors.push({ path: file, error: errorMsg });
				this.logger.warn(`Failed to parse ${file}: ${error}`);
			}
		}

		return { docs, errors };
	}

	/**
	 * Extract title from content or filename
	 */
	private extractTitle(content: string, filePath: string): string {
		const h1Match = content.match(/^#\s+(.+)$/m);
		if (h1Match) {
			return h1Match[1];
		}

		// Fallback to filename
		const parts = filePath.split("/");
		return parts[parts.length - 1].replace(".md", "");
	}

	/**
	 * Extract graph metadata
	 */
	private extractGraphMetadata(
		frontmatter: unknown,
	): GraphMetadata | undefined {
		const fm = frontmatter as Record<string, unknown>;
		if (!fm?.graph) {
			return undefined;
		}

		const result = GraphMetadataSchema.safeParse(fm.graph);
		return result.success ? result.data : undefined;
	}

	/**
	 * Compute SHA256 hash
	 */
	private computeHash(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}
}
