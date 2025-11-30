/**
 * Embedding types and interfaces for @research/graph
 */

export interface EmbeddingProvider {
	/** Provider name (e.g., 'openai', 'voyage', 'mock') */
	name: string;
	/** Generate embedding for a single text */
	generateEmbedding(text: string): Promise<number[]>;
	/** Generate embeddings for multiple texts (batch) */
	generateEmbeddings(texts: string[]): Promise<number[][]>;
	/** Embedding vector dimensions */
	dimensions: number;
}

export interface EmbeddingConfig {
	provider: "openai" | "voyage" | "nomic" | "mock";
	apiKey?: string;
	model?: string;
	dimensions?: number;
}

export interface EmbeddingResult {
	text: string;
	embedding: number[];
	model: string;
	dimensions: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
	provider: "voyage",
	model: "voyage-3.5-lite",
	dimensions: 512,
};
