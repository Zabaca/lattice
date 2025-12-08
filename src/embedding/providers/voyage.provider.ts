/**
 * Voyage AI Embedding Provider
 *
 * Implements the EmbeddingProvider interface using Voyage AI's embedding models.
 * Supports batch embedding and Matryoshka dimensions.
 */

import { VoyageEmbeddingResponseSchema } from "../../schemas/embedding.schemas.js";
import type { EmbeddingProvider } from "../embedding.types";

export interface VoyageEmbeddingConfig {
	apiKey?: string;
	model?: string;
	dimensions?: number;
	inputType?: "document" | "query";
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
	readonly name = "voyage";
	readonly dimensions: number;
	private model: string;
	private apiKey: string;
	private inputType: "document" | "query";
	private baseUrl = "https://api.voyageai.com/v1";

	constructor(config?: VoyageEmbeddingConfig) {
		const apiKey = config?.apiKey || process.env.VOYAGE_API_KEY;
		if (!apiKey) {
			throw new Error(
				"Voyage API key is required. Set VOYAGE_API_KEY environment variable or pass apiKey in config.",
			);
		}

		this.apiKey = apiKey;
		this.model = config?.model || "voyage-3.5-lite";
		this.dimensions = config?.dimensions || 512;
		this.inputType = config?.inputType || "document";
	}

	/**
	 * Generate an embedding for a single text string (document storage)
	 */
	async generateEmbedding(text: string): Promise<number[]> {
		const embeddings = await this.generateEmbeddings([text]);
		return embeddings[0];
	}

	/**
	 * Generate embedding optimized for search queries
	 * Uses input_type="query" for asymmetric retrieval
	 */
	async generateQueryEmbedding(text: string): Promise<number[]> {
		const embeddings = await this.generateEmbeddingsWithType([text], "query");
		return embeddings[0];
	}

	/**
	 * Generate embeddings for multiple texts (batch, document storage)
	 * Voyage API supports up to 1000 texts per request
	 */
	async generateEmbeddings(texts: string[]): Promise<number[][]> {
		return this.generateEmbeddingsWithType(texts, this.inputType);
	}

	/**
	 * Internal method to generate embeddings with specified input type
	 */
	private async generateEmbeddingsWithType(
		texts: string[],
		inputType: "document" | "query",
	): Promise<number[][]> {
		if (!texts || texts.length === 0) {
			return [];
		}

		try {
			const response = await fetch(`${this.baseUrl}/embeddings`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					input: texts,
					output_dimension: this.dimensions,
					input_type: inputType,
				}),
			});

			if (!response.ok) {
				const error = await response.json().catch(() => ({}));
				throw new Error(
					`Voyage API error: ${response.status} ${JSON.stringify(error)}`,
				);
			}

			// Validate response with Zod schema (fail-fast on invalid API response)
			const data = VoyageEmbeddingResponseSchema.parse(await response.json());

			// Sort by index to maintain order and extract embeddings
			const sortedData = data.data.sort((a, b) => a.index - b.index);
			return sortedData.map((item) => item.embedding);
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Failed to generate embeddings: ${error.message}`);
			}
			throw error;
		}
	}
}
