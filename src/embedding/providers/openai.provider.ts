/**
 * OpenAI Embedding Provider
 *
 * Implements the EmbeddingProvider interface using OpenAI's embedding models.
 * Supports batch embedding for efficiency.
 */

import type { EmbeddingProvider } from '../embedding.types';

export interface OpenAIEmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private model: string;
  private apiKey: string;
  private baseUrl = 'https://api.openai.com/v1';

  constructor(config?: OpenAIEmbeddingConfig) {
    const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass apiKey in config.'
      );
    }

    this.apiKey = apiKey;
    this.model = config?.model || 'text-embedding-3-small';
    this.dimensions = config?.dimensions || 1536;
  }

  /**
   * Generate an embedding for a single text string
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  /**
   * Generate embeddings for multiple texts (batch)
   * OpenAI API supports batch requests for efficiency
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimensions,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          `OpenAI API error: ${response.status} ${JSON.stringify(error)}`
        );
      }

      const data = (await response.json()) as {
        data: Array<{ index: number; embedding: number[] }>;
      };

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
