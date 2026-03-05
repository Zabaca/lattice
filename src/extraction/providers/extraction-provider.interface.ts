/**
 * Entity Extraction Provider Interface
 *
 * Defines the contract for LLM-based entity extraction providers.
 * Implementations can use Claude, OpenAI, or other LLM services.
 */

import type { Entity, Relationship } from "../../utils/frontmatter.js";

export interface ExtractionResult {
	entities: Entity[];
	relationships: Relationship[];
	summary: string;
	success: boolean;
	error?: string;
	rawResponse?: string;
}

export interface LLMProviderConfig {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	maxTurns?: number;
}

export interface EntityExtractionProvider {
	readonly name: string;

	/**
	 * Extract entities, relationships, and summary from a document.
	 *
	 * @param filePath - Absolute path to the markdown file
	 * @param content - Document content
	 * @returns ExtractionResult with entities, relationships, summary
	 */
	extractFromDocument(filePath: string, content: string): Promise<ExtractionResult>;
}
