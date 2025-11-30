import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { glob } from "glob";
import { resolve } from "path";
import { DocsConfigSchema } from "../schemas/config.schemas.js";
import {
	Entity,
	EntitySchema,
	GraphMetadata,
	GraphMetadataSchema,
	parseFrontmatter,
	Relationship,
	RelationshipSchema,
	RelationTypeSchema,
} from "../utils/frontmatter.js";

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
export class DocumentParserService {
	private readonly logger = new Logger(DocumentParserService.name);
	private docsPath: string;

	constructor() {
		// Validate config with Zod schema
		const config = DocsConfigSchema.parse({
			projectRoot: process.env.PROJECT_ROOT,
			docsPath: process.env.DOCS_PATH,
		});

		// Use DOCS_PATH if absolute, otherwise resolve relative to project root
		if (config.docsPath.startsWith("/")) {
			this.docsPath = config.docsPath;
		} else {
			this.docsPath = resolve(config.projectRoot, config.docsPath);
		}
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
	 * Parse a single document
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

		// Extract entities with validation
		const entities = this.extractEntities(parsed.frontmatter, filePath);

		// Extract relationships with validation
		const relationships = this.extractRelationships(
			parsed.frontmatter,
			filePath,
		);

		// Extract graph metadata
		const graphMetadata = this.extractGraphMetadata(parsed.frontmatter);

		return {
			path: filePath,
			title,
			content: parsed.content,
			contentHash,
			frontmatterHash,
			summary: parsed.frontmatter?.summary,
			topic: parsed.frontmatter?.topic,
			entities,
			relationships,
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
	 * Extract and validate entities from frontmatter
	 * Throws error if entities exist but have invalid schema
	 */
	private extractEntities(frontmatter: any, docPath: string): Entity[] {
		if (!frontmatter?.entities || !Array.isArray(frontmatter.entities)) {
			return [];
		}

		const validEntities: Entity[] = [];
		const errors: string[] = [];

		for (let i = 0; i < frontmatter.entities.length; i++) {
			const e = frontmatter.entities[i];
			const result = EntitySchema.safeParse(e);
			if (result.success) {
				validEntities.push(result.data);
			} else {
				const entityPreview =
					typeof e === "string" ? `"${e}"` : JSON.stringify(e);
				errors.push(
					`Entity[${i}]: ${entityPreview} - Expected object with {name, type}, got ${typeof e}`,
				);
			}
		}

		if (errors.length > 0) {
			const errorMsg = `Invalid entity schema in ${docPath}:\n  ${errors.join("\n  ")}`;
			throw new Error(errorMsg);
		}

		return validEntities;
	}

	/**
	 * Extract and validate relationships, resolving 'this' to document path
	 * Throws error if relationships exist but have invalid schema
	 */
	private extractRelationships(
		frontmatter: any,
		docPath: string,
	): Relationship[] {
		if (
			!frontmatter?.relationships ||
			!Array.isArray(frontmatter.relationships)
		) {
			return [];
		}

		const validRelationships: Relationship[] = [];
		const errors: string[] = [];

		const validRelationTypes = RelationTypeSchema.options;

		for (let i = 0; i < frontmatter.relationships.length; i++) {
			const r = frontmatter.relationships[i];
			const result = RelationshipSchema.safeParse(r);
			if (result.success) {
				const rel = result.data;
				// Replace 'this' with document path
				if (rel.source === "this") {
					rel.source = docPath;
				}
				if (rel.target === "this") {
					rel.target = docPath;
				}
				validRelationships.push(rel);
			} else {
				if (typeof r === "string") {
					errors.push(
						`Relationship[${i}]: "${r}" - Expected object with {source, relation, target}, got string`,
					);
				} else if (typeof r === "object" && r !== null) {
					// Check what's specifically wrong
					const issues: string[] = [];
					if (!r.source) issues.push("missing source");
					if (!r.target) issues.push("missing target");
					if (!r.relation) {
						issues.push("missing relation");
					} else if (!validRelationTypes.includes(r.relation)) {
						issues.push(
							`invalid relation "${r.relation}" (allowed: ${validRelationTypes.join(", ")})`,
						);
					}
					errors.push(`Relationship[${i}]: ${issues.join(", ")}`);
				} else {
					errors.push(`Relationship[${i}]: Expected object, got ${typeof r}`);
				}
			}
		}

		if (errors.length > 0) {
			const errorMsg = `Invalid relationship schema in ${docPath}:\n  ${errors.join("\n  ")}`;
			throw new Error(errorMsg);
		}

		return validRelationships;
	}

	/**
	 * Extract graph metadata
	 */
	private extractGraphMetadata(frontmatter: any): GraphMetadata | undefined {
		if (!frontmatter?.graph) {
			return undefined;
		}

		const result = GraphMetadataSchema.safeParse(frontmatter.graph);
		return result.success ? result.data : undefined;
	}

	/**
	 * Compute SHA256 hash
	 */
	private computeHash(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}
}
