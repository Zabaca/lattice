/**
 * OpenAI Entity Extraction Provider
 *
 * Uses OpenAI-compatible API for entity extraction.
 * Supports OpenAI, Ollama, LM Studio, and other compatible services.
 */

import OpenAI from "openai";
import { z } from "zod";
import { EntityTypeSchema, RelationTypeSchema } from "../../graph/graph.types.js";
import type { Entity, Relationship } from "../../utils/frontmatter.js";
import type {
	EntityExtractionProvider,
	ExtractionResult,
	LLMProviderConfig,
} from "./extraction-provider.interface.js";

const ExtractionResponseSchema = z.object({
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
});

function validateRelationships(
	entities: Array<{ name: string; type: string; description: string }>,
	relationships: Array<{ source: string; relation: string; target: string }>,
): string[] {
	const errors: string[] = [];
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

export class OpenAIExtractionProvider implements EntityExtractionProvider {
	readonly name = "openai";
	private client: OpenAI;
	private model: string;
	private maxRetries: number;

	constructor(config?: LLMProviderConfig) {
		const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;

		if (!apiKey) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable.",
			);
		}

		const baseURL = config?.baseUrl || process.env.OPENAI_BASE_URL;

		this.client = new OpenAI({
			apiKey,
			baseURL,
		});

		this.model = config?.model || "gpt-4o-mini";
		this.maxRetries = 3;
	}

	async extractFromDocument(
		filePath: string,
		content: string,
	): Promise<ExtractionResult> {
		const prompt = this.buildExtractionPrompt(filePath, content);

		for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
			try {
				const response = await this.client.chat.completions.create({
					model: this.model,
					messages: [
						{
							role: "system",
							content:
								"You are an expert at extracting structured information from documents. Always respond with valid JSON.",
						},
						{ role: "user", content: prompt },
					],
					response_format: { type: "json_object" },
					temperature: 0.1,
				});

				const rawContent = response.choices[0]?.message?.content;
				if (!rawContent) {
					throw new Error("Empty response from OpenAI API");
				}

				const parsed = JSON.parse(rawContent);
				const validated = ExtractionResponseSchema.safeParse(parsed);

				if (!validated.success) {
					// If validation fails, try again with more specific prompt
					if (attempt < this.maxRetries) {
						continue;
					}
					return {
						entities: [],
						relationships: [],
						summary: "",
						success: false,
						error: `Validation failed: ${validated.error.message}`,
						rawResponse: rawContent,
					};
				}

				const extraction = validated.data;

				// Validate relationships reference valid entities
				const validationErrors = validateRelationships(
					extraction.entities,
					extraction.relationships,
				);
				if (validationErrors.length > 0) {
					if (attempt < this.maxRetries) {
						continue;
					}
					return {
						entities: extraction.entities as Entity[],
						relationships: extraction.relationships as Relationship[],
						summary: extraction.summary,
						success: false,
						error: `Relationship validation failed: ${validationErrors.join(", ")}`,
						rawResponse: rawContent,
					};
				}

				return this.buildSuccessResult(extraction, filePath);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);

				if (attempt < this.maxRetries) {
					continue;
				}

				return {
					entities: [],
					relationships: [],
					summary: "",
					success: false,
					error: `Extraction failed after ${this.maxRetries} attempts: ${errorMsg}`,
				};
			}
		}

		return {
			entities: [],
			relationships: [],
			summary: "",
			success: false,
			error: "Unexpected end of extraction loop",
		};
	}

	private buildExtractionPrompt(filePath: string, content: string): string {
		return `Analyze this markdown document and extract entities, relationships, and a summary.

File: ${filePath}

<document>
${content}</document>

## Instructions

Extract the following and return as JSON with EXACTLY this schema:

### 1. Entities (array of 3-10 objects)
Each entity must have:
- "name": string (entity name)
- "type": one of "Topic", "Technology", "Concept", "Tool", "Process", "Person", "Organization", "Document", "Question"
- "description": string (brief description)

### 2. Relationships (array of objects)
Each relationship must have:
- "source": "this" (for document-to-entity) or an entity name from your entities list
- "relation": "REFERENCES" or "ANSWERED_BY"
- "target": an entity name from your entities list

Use ANSWERED_BY when a Question entity is answered by this document.

### 3. Summary
A 50-100 word summary of the document's main purpose and key concepts.

## Output Format

Return ONLY a JSON object with this exact structure (no markdown, no code blocks):

{
  "entities": [
    {"name": "...", "type": "...", "description": "..."}
  ],
  "relationships": [
    {"source": "...", "relation": "...", "target": "..."}
  ],
  "summary": "..."
}`;
	}

	private buildSuccessResult(
		extraction: {
			entities: Array<{ name: string; type: string; description: string }>;
			relationships: Array<{ source: string; relation: string; target: string }>;
			summary: string;
		},
		filePath: string,
	): ExtractionResult {
		const relationships = extraction.relationships.map((rel) => ({
			...rel,
			source: rel.source === "this" ? filePath : rel.source,
		})) as Relationship[];

		return {
			entities: extraction.entities as Entity[],
			relationships,
			summary: extraction.summary,
			success: true,
		};
	}
}
