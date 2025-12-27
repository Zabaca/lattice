import { readFile } from "node:fs/promises";
import {
	createSdkMcpServer,
	query,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { EntityTypeSchema, RelationTypeSchema } from "../graph/graph.types.js";
import type { Entity, Relationship } from "../utils/frontmatter.js";

export interface ExtractionResult {
	entities: Entity[];
	relationships: Relationship[];
	summary: string;
	success: boolean;
	error?: string;
	rawResponse?: string; // Included when parsing fails for debugging
}

/**
 * Validate extracted entities and relationships.
 * Returns array of error messages (empty = valid).
 * Exported for testing.
 */
export function validateExtraction(
	input: { entities: Entity[]; relationships: Relationship[]; summary: string },
	_filePath: string,
): string[] {
	const errors: string[] = [];
	const { entities, relationships } = input ?? {};

	// Defensive checks for malformed input
	if (!entities || !Array.isArray(entities)) {
		return ["Entities array is missing or invalid"];
	}
	if (!relationships || !Array.isArray(relationships)) {
		return ["Relationships array is missing or invalid"];
	}

	// Build entity name set
	const entityNames = new Set(entities.map((e) => e.name));

	// Validate relationships reference extracted entities
	for (const rel of relationships) {
		// Source can be 'this' or an entity name
		if (rel.source !== "this" && !entityNames.has(rel.source)) {
			errors.push(
				`Relationship source "${rel.source}" not found in extracted entities`,
			);
		}

		// Target must be an extracted entity name
		if (!entityNames.has(rel.target)) {
			errors.push(
				`Relationship target "${rel.target}" not found in extracted entities`,
			);
		}
	}

	return errors;
}

/**
 * Create a validation MCP server with filePath context.
 * Must be created per-extraction to have access to filePath.
 */
function createValidationServer(filePath: string) {
	return createSdkMcpServer({
		name: "entity-validator",
		version: "1.0.0",
		tools: [
			tool(
				"validate_extraction",
				"Validate your extracted entities and relationships. Call this to check your work before finishing.",
				{
					entities: z.array(
						z.object({
							name: z.string().min(1),
							type: EntityTypeSchema,
							description: z.string().min(1),
						}),
					),
					relationships: z.array(
						z.object({
							source: z.string().min(1),
							relation: RelationTypeSchema,
							target: z.string().min(1),
						}),
					),
					summary: z.string().min(10),
				},
				async (args) => {
					const errors = validateExtraction(
						args as {
							entities: Entity[];
							relationships: Relationship[];
							summary: string;
						},
						filePath,
					);

					if (errors.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "✓ Validation passed. Your extraction is correct.",
								},
							],
						};
					}

					return {
						content: [
							{
								type: "text" as const,
								text: `✗ Validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nPlease fix these errors and call validate_extraction again.`,
							},
						],
					};
				},
			),
		],
	});
}

/**
 * Entity Extractor Service using Claude Agent SDK.
 *
 * Uses Claude to analyze document content and extract:
 * - Entities (technologies, concepts, tools, processes, organizations)
 * - Relationships between entities
 * - Document summary for embeddings
 *
 * Features:
 * - MCP validation tool for self-correction
 * - Rate limited to avoid API throttling
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
			const promptText = this.buildExtractionPrompt(filePath, content);

			// Create validation server with filePath context
			const validationServer = createValidationServer(filePath);

			// Track last validated extraction
			let lastValidExtraction: {
				entities: Entity[];
				relationships: Relationship[];
				summary: string;
			} | null = null;

			for await (const message of query({
				prompt: promptText,
				options: {
					maxTurns: 3, // extract → validate → fix+validate
					model: "claude-haiku-4-5-20251001",
					mcpServers: {
						"entity-validator": validationServer,
					},
					allowedTools: ["mcp__entity-validator__validate_extraction"],
					permissionMode: "default",
				},
			})) {
				if (message.type === "assistant") {
					// Track tool calls to capture last extraction
					for (const block of message.message?.content ?? []) {
						if (
							block.type === "tool_use" &&
							block.name === "mcp__entity-validator__validate_extraction"
						) {
							// Tool validated it, store if validation passed
							const input = block.input as {
								entities: Entity[];
								relationships: Relationship[];
								summary: string;
							};
							const validationErrors = validateExtraction(input, filePath);
							if (validationErrors.length === 0) {
								lastValidExtraction = input;
							}
						}
					}
				} else if (message.type === "result") {
					// If we have a validated extraction, return success
					// (even if max_turns was reached - validation passing is what matters)
					if (lastValidExtraction) {
						this.logger.debug(
							`Extraction for ${filePath} completed in ${message.duration_ms}ms`,
						);
						return this.buildSuccessResult(lastValidExtraction, filePath);
					}
					// No valid extraction - return error with details
					const errorReason =
						message.subtype === "error_max_turns"
							? "Max turns reached without valid extraction"
							: message.subtype === "error_during_execution"
								? "Error during execution"
								: `Extraction failed: ${message.subtype}`;
					return {
						entities: [],
						relationships: [],
						summary: "",
						success: false,
						error: errorReason,
					};
				}
			}

			throw new Error("No result received from SDK");
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

Extract the following and call the validation tool with EXACTLY this schema:

### 1. Entities (array of 3-10 objects)
Each entity must have:
- "name": string (entity name)
- "type": one of "Topic", "Technology", "Concept", "Tool", "Process", "Person", "Organization", "Document", "Question"
- "description": string (brief description)

### 2. Relationships (array of objects)
Each relationship must have:
- "source": "this" (for document-to-entity) or an entity name
- "relation": "REFERENCES" or "ANSWERED_BY" (IMPORTANT: use "relation", not "type")
- "target": an entity name from your entities list

Use ANSWERED_BY when a Question entity is answered by this document (source: Question name, target: "this").

### 3. Summary
A 50-100 word summary of the document's main purpose and key concepts.

## IMPORTANT: Validation Required

You MUST call mcp__entity-validator__validate_extraction tool.
Pass the three fields DIRECTLY as top-level arguments (NOT wrapped in an "extraction" object):
- entities: your entities array
- relationships: your relationships array
- summary: your summary string

Example tool call structure:
{
  "entities": [...],
  "relationships": [...],
  "summary": "..."
}

If validation fails, fix the errors and call the tool again.
Only finish after validation passes.`;
	}

	/**
	 * Build success result from validated extraction.
	 */
	private buildSuccessResult(
		extraction: {
			entities: Entity[];
			relationships: Relationship[];
			summary: string;
		},
		filePath: string,
	): ExtractionResult {
		// Transform "this" to file path in relationships
		const relationships = extraction.relationships.map((rel) => ({
			...rel,
			source: rel.source === "this" ? filePath : rel.source,
		}));

		return {
			entities: extraction.entities,
			relationships,
			summary: extraction.summary,
			success: true,
		};
	}
}
