import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Injectable, Logger } from "@nestjs/common";
import type { Entity, Relationship } from "../utils/frontmatter.js";

export interface ExtractionResult {
	entities: Entity[];
	relationships: Relationship[];
	summary: string;
	success: boolean;
	error?: string;
}

/**
 * Entity Extractor Service using Claude Agent SDK.
 *
 * Uses Claude to analyze document content and extract:
 * - Entities (technologies, concepts, tools, processes, organizations)
 * - Relationships between entities
 * - Document summary for embeddings
 *
 * Rate limited to avoid API throttling.
 */
@Injectable()
export class EntityExtractorService {
	private readonly logger = new Logger(EntityExtractorService.name);

	// Rate limiting: track last extraction time
	private lastExtractionTime = 0;
	private readonly minIntervalMs = 500; // 500ms between extractions (120/min max)

	/**
	 * Extract entities, relationships, and summary from a document.
	 *
	 * @param filePath - Absolute path to the markdown file
	 * @returns ExtractionResult with entities, relationships, summary
	 */
	async extractFromDocument(filePath: string): Promise<ExtractionResult> {
		// Apply rate limiting
		await this.rateLimit();

		try {
			// Read document content
			const content = await readFile(filePath, "utf-8");

			// Build extraction prompt
			const prompt = this.buildExtractionPrompt(filePath, content);

			// Call Claude Agent SDK
			let result = "";
			for await (const message of query({
				prompt,
				options: {
					maxTurns: 1,
					model: "claude-3-5-haiku-20241022",
					allowedTools: [], // No tools needed - just text analysis
					permissionMode: "plan", // Read-only mode
				},
			})) {
				if (message.type === "assistant" && message.message?.content) {
					for (const block of message.message.content) {
						if ("text" in block) {
							result += block.text;
						}
					}
				} else if (message.type === "result") {
					this.logger.debug(
						`Extraction for ${filePath} completed in ${message.duration_ms}ms`,
					);
				}
			}

			// Parse the JSON response
			return this.parseExtractionResult(result, filePath);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.logger.error(
				`Entity extraction failed for ${filePath}: ${errorMsg}`,
			);
			return {
				entities: [],
				relationships: [],
				summary: "",
				success: false,
				error: errorMsg,
			};
		}
	}

	/**
	 * Extract entities from multiple documents with progress reporting.
	 */
	async extractFromDocuments(
		filePaths: string[],
		onProgress?: (completed: number, total: number, path: string) => void,
	): Promise<Map<string, ExtractionResult>> {
		const results = new Map<string, ExtractionResult>();

		for (let i = 0; i < filePaths.length; i++) {
			const path = filePaths[i];
			onProgress?.(i, filePaths.length, path);

			const result = await this.extractFromDocument(path);
			results.set(path, result);
		}

		return results;
	}

	/**
	 * Apply rate limiting between extractions.
	 */
	private async rateLimit(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastExtractionTime;

		if (elapsed < this.minIntervalMs) {
			const waitTime = this.minIntervalMs - elapsed;
			await new Promise((resolve) => setTimeout(resolve, waitTime));
		}

		this.lastExtractionTime = Date.now();
	}

	/**
	 * Build the extraction prompt for Claude.
	 * Public for testing purposes.
	 */
	buildExtractionPrompt(filePath: string, content: string): string {
		return `Analyze this markdown document and extract entities, relationships, and a summary.

File: ${filePath}

<document>
${content}
</document>

## Instructions

Extract the following and respond with ONLY valid JSON (no markdown code fences):

1. **Entities** (3-10 most significant):
   - Technologies: Languages, frameworks, databases, libraries
   - Concepts: Patterns, methodologies, theories
   - Tools: Software, services, platforms
   - Processes: Workflows, procedures
   - Organizations: Companies, projects

2. **Relationships** between entities:
   - Use "this" as source when the document references an entity
   - Use REFERENCES as the relation type

3. **Summary** (50-100 words):
   - Document's main purpose
   - Key technologies/concepts
   - Primary conclusions

## Entity Types
Valid types: Topic, Technology, Concept, Tool, Process, Person, Organization, Document

## Response Format
{
  "entities": [
    {"name": "EntityName", "type": "Technology", "description": "Brief description"}
  ],
  "relationships": [
    {"source": "this", "relation": "REFERENCES", "target": "EntityName"}
  ],
  "summary": "2-3 sentence summary..."
}

Respond with ONLY the JSON object, no other text.`;
	}

	/**
	 * Parse Claude's response into ExtractionResult.
	 * Public for testing purposes.
	 */
	parseExtractionResult(response: string, filePath: string): ExtractionResult {
		try {
			// Try to extract JSON from the response
			// Claude sometimes wraps in code fences despite instructions
			let jsonStr = response.trim();

			// Remove markdown code fences if present
			const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (jsonMatch) {
				jsonStr = jsonMatch[1].trim();
			}

			// Parse JSON
			const parsed = JSON.parse(jsonStr);

			// Validate and sanitize entities
			const entities: Entity[] = [];
			if (Array.isArray(parsed.entities)) {
				for (const e of parsed.entities) {
					if (this.isValidEntity(e)) {
						entities.push({
							name: String(e.name),
							type: this.normalizeEntityType(e.type),
							description: String(e.description || ""),
						});
					}
				}
			}

			// Validate and sanitize relationships
			const relationships: Relationship[] = [];
			if (Array.isArray(parsed.relationships)) {
				for (const r of parsed.relationships) {
					if (this.isValidRelationship(r)) {
						relationships.push({
							source: r.source === "this" ? filePath : String(r.source),
							relation: "REFERENCES", // Only valid relation type
							target: String(r.target),
						});
					}
				}
			}

			const summary = String(parsed.summary || "");

			return {
				entities,
				relationships,
				summary,
				success: true,
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.logger.warn(
				`Failed to parse extraction result for ${filePath}: ${errorMsg}`,
			);
			this.logger.debug(`Raw response: ${response.substring(0, 500)}...`);

			return {
				entities: [],
				relationships: [],
				summary: "",
				success: false,
				error: `JSON parse error: ${errorMsg}`,
			};
		}
	}

	/**
	 * Check if an object is a valid entity.
	 */
	private isValidEntity(e: unknown): boolean {
		if (typeof e !== "object" || e === null) return false;
		const obj = e as Record<string, unknown>;
		return typeof obj.name === "string" && obj.name.length > 0;
	}

	/**
	 * Check if an object is a valid relationship.
	 */
	private isValidRelationship(r: unknown): boolean {
		if (typeof r !== "object" || r === null) return false;
		const obj = r as Record<string, unknown>;
		return (
			typeof obj.source === "string" &&
			typeof obj.target === "string" &&
			obj.source.length > 0 &&
			obj.target.length > 0
		);
	}

	/**
	 * Normalize entity type to valid enum value.
	 * Public for testing purposes.
	 */
	normalizeEntityType(type: unknown): Entity["type"] {
		const validTypes = [
			"Topic",
			"Technology",
			"Concept",
			"Tool",
			"Process",
			"Person",
			"Organization",
			"Document",
		] as const;

		if (typeof type === "string") {
			// Try exact match first
			const exactMatch = validTypes.find(
				(t) => t.toLowerCase() === type.toLowerCase(),
			);
			if (exactMatch) return exactMatch;

			// Common aliases
			const aliases: Record<string, Entity["type"]> = {
				platform: "Tool",
				service: "Tool",
				framework: "Technology",
				library: "Technology",
				language: "Technology",
				database: "Technology",
				pattern: "Concept",
				methodology: "Process",
				workflow: "Process",
				company: "Organization",
				team: "Organization",
				project: "Topic",
				feature: "Concept",
			};

			const aliasMatch = aliases[type.toLowerCase()];
			if (aliasMatch) return aliasMatch;
		}

		// Default to Concept
		return "Concept";
	}
}
