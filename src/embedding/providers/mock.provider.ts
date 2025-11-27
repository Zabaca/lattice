import type { EmbeddingProvider } from '../embedding.types';

/**
 * Mock embedding provider for testing
 * Returns deterministic embeddings based on text hash
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimensions: number;

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Generate deterministic embedding based on text content
    return this.generateDeterministicEmbedding(text);
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.generateEmbedding(text)));
  }

  /**
   * Generate deterministic embedding from text
   * Uses simple hash-based approach for reproducibility in tests
   */
  private generateDeterministicEmbedding(text: string): number[] {
    const embedding: number[] = new Array(this.dimensions);

    // Simple hash function for deterministic values
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }

    // Generate embedding values using hash as seed
    for (let i = 0; i < this.dimensions; i++) {
      // Use combination of hash and index for variety
      const seed = (hash * (i + 1)) ^ (i * 31);
      // Normalize to [-1, 1] range like real embeddings
      embedding[i] = ((seed % 2000) - 1000) / 1000;
    }

    // Normalize to unit length (like real embeddings)
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => val / magnitude);
  }
}
