/**
 * Claude Entity Extraction Provider
 *
 * Uses Anthropic's Claude Agent SDK for entity extraction with MCP validation.
 */

import {
	createSdkMcpServer,
	query,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EntityTypeSchema, RelationTypeSchema } from "../../graph/graph.types.js";
import type { Entity, Relationship } from "../../utils/frontmatter.js";
import type {
	EntityExtractionProvider,
	ExtractionResult,
	LLMProviderConfig,
} from "./extraction-provider.interface.js";

/**
 * Validate extracted entities and relationships.
 * Returns array of error messages (empty = valid).
 */
export function validateExtraction(
	input: { entities: Entity[]; relationships: Relationship[]; summary: string },
	_filePath: string,
): string[] {
	const errors: string[] = [];
	const { entities, relationships } = input ?? {};

	if (!entities || !Array.isArray(entities)) {
		return ["Entities array is missing or invalid"];
	}
	if (!relationships || !Array.isArray(relationships)) {
		return ["Relationships array is missing or invalid"];
	}

	const entityNames = new Set(entities.map((e) => e.name));

	for (const rel of relationships) {
		if (rel.source !== "this" && !entityNames.has(rel.source)) {
			errors.push(
				`Relationship source "${rel.source}" not found in extracted entities`,
			);
		}
		if (!entityNames.has(rel.target)) {
			errors.push(
				`Relationship target "${rel.target}" not found in extracted entities`,
			);
		}
	}

	return errors;
}

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

export class ClaudeExtractionProvider implements EntityExtractionProvider {
	readonly name = "claude";
	private config: LLMProviderConfig & { apiKey: string; model: string; maxTurns: number };

	constructor(config?: LLMProviderConfig) {
		this.config = {
			apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY || "",
			baseUrl: config?.baseUrl || process.env.ANTHROPIC_BASE_URL,
			model: config?.model || "claude-haiku-4-5-20251001",
			maxTurns: config?.maxTurns || 3,
		};

		if (!this.config.apiKey) {
			throw new Error(
				"Claude API key is required. Set ANTHROPIC_API_KEY environment variable.",
			);
		}
	}

	async extractFromDocument(
		filePath: string,
		content: string,
	): Promise<ExtractionResult> {
		const promptText = this.buildExtractionPrompt(filePath, content);
		const validationServer = createValidationServer(filePath);

		let lastValidExtraction: {
			entities: Entity[];
			relationships: Relationship[];
			summary: string;
		} | null = null;

		for await (const message of query({
			prompt: promptText,
			options: {
				maxTurns: this.config.maxTurns,
				model: this.config.model,
				mcpServers: {
					"entity-validator": validationServer,
				},
				allowedTools: ["mcp__entity-validator__validate_extraction"],
				permissionMode: "default",
			},
		})) {
			if (message.type === "assistant") {
				for (const block of message.message?.content ?? []) {
					if (
						block.type === "tool_use" &&
						block.name === "mcp__entity-validator__validate_extraction"
					) {
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
				if (lastValidExtraction) {
					return this.buildSuccessResult(lastValidExtraction, filePath);
				}
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
	}

	private buildExtractionPrompt(filePath: string, content: string): string {
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

	private buildSuccessResult(
		extraction: {
			entities: Entity[];
			relationships: Relationship[];
			summary: string;
		},
		filePath: string,
	): ExtractionResult {
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
