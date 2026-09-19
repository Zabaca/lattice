/**
 * Entity Extractor Service
 *
 * Uses configurable LLM provider to analyze document content and extract:
 * - Entities (technologies, concepts, tools, processes, organizations)
 * - Relationships between entities
 * - Document summary for embeddings
 *
 * Features:
 * - Multiple provider support (Claude, OpenAI)
 * - Rate limited to avoid API throttling
 */

import { readFile } from "node:fs/promises";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	ClaudeExtractionProvider,
	OpenAIExtractionProvider,
	validateExtraction,
} from "../extraction/providers/index.js";
import type {
	EntityExtractionProvider,
	ExtractionResult,
} from "../extraction/providers/index.js";
import { LLMConfigSchema } from "../schemas/config.schemas.js";
import type { LLMConfig } from "../schemas/config.schemas.js";

export { validateExtraction, type ExtractionResult };

@Injectable()
export class EntityExtractorService {
	private readonly logger = new Logger(EntityExtractorService.name);
	private provider: EntityExtractionProvider | null = null;
	private config: LLMConfig;

	// Rate limiting: track last extraction time
	private lastExtractionTime = 0;
	private readonly minIntervalMs = 500; // 500ms between extractions (120/min max)

	constructor(private configService: ConfigService) {
		this.config = this.loadConfig();
	}

	/**
	 * Lazily initialize and return the extraction provider.
	 */
	private getProvider(): EntityExtractionProvider {
		if (!this.provider) {
			this.provider = this.createProvider();
			this.logger.log(`Initialized extraction provider: ${this.provider.name}`);
		}
		return this.provider;
	}

	private loadConfig(): LLMConfig {
		const provider = this.configService.get<string>("LLM_PROVIDER");
		const apiKey = this.configService.get<string>("LLM_API_KEY");
		const baseUrl = this.configService.get<string>("LLM_BASE_URL");
		const model = this.configService.get<string>("LLM_MODEL");
		const maxTurns = this.configService.get<number>("LLM_MAX_TURNS");

		// Infer API key from provider-specific env vars if not set
		let inferredApiKey = apiKey;
		if (!inferredApiKey) {
			if (provider === "claude" || !provider) {
				inferredApiKey = this.configService.get<string>("ANTHROPIC_API_KEY");
			} else if (provider === "openai") {
				inferredApiKey = this.configService.get<string>("OPENAI_API_KEY");
			}
		}

		return LLMConfigSchema.parse({
			provider,
			apiKey: inferredApiKey,
			baseUrl,
			model,
			maxTurns,
		});
	}

	private createProvider(): EntityExtractionProvider {
		switch (this.config.provider) {
			case "claude": {
				if (!this.config.apiKey) {
					throw new Error(
						"ANTHROPIC_API_KEY environment variable is required for Claude provider.",
					);
				}
				return new ClaudeExtractionProvider({
					apiKey: this.config.apiKey,
					baseUrl: this.config.baseUrl,
					model: this.config.model,
					maxTurns: this.config.maxTurns,
				});
			}
			case "openai": {
				if (!this.config.apiKey) {
					throw new Error(
						"OPENAI_API_KEY environment variable is required for OpenAI provider.",
					);
				}
				return new OpenAIExtractionProvider({
					apiKey: this.config.apiKey,
					baseUrl: this.config.baseUrl,
					model: this.config.model,
				});
			}
			default:
				throw new Error(
					`Unknown LLM provider: ${this.config.provider}. Use 'claude' or 'openai'.`,
				);
		}
	}

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

			// Use provider to extract
			return await this.getProvider().extractFromDocument(filePath, content);
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
	 * Build the extraction prompt for debugging/inspection.
	 * Public for testing purposes.
	 */
	buildExtractionPrompt(filePath: string, content: string): string {
		// Delegate to a temporary provider instance for prompt building
		// This is a workaround since the prompt building is now internal to providers
		return `Analyze this markdown document and extract entities, relationships, and a summary.

File: ${filePath}

<document>
${content}
</document>

## Instructions

Extract the following:

### 1. Entities (array of 3-10 objects)
Each entity must have:
- "name": string (entity name)
- "type": one of "Topic", "Technology", "Concept", "Tool", "Process", "Person", "Organization", "Document", "Question"
- "description": string (brief description)

### 2. Relationships (array of objects)
Each relationship must have:
- "source": "this" (for document-to-entity) or an entity name
- "relation": "REFERENCES" or "ANSWERED_BY"
- "target": an entity name from your entities list

### 3. Summary
A 50-100 word summary of the document's main purpose and key concepts.`;
	}
}
