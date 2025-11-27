import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmbeddingProvider, EmbeddingConfig } from './embedding.types';
import { DEFAULT_EMBEDDING_CONFIG } from './embedding.types';
import { OpenAIEmbeddingProvider } from './providers/openai.provider';
import { VoyageEmbeddingProvider } from './providers/voyage.provider';
import { MockEmbeddingProvider } from './providers/mock.provider';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private provider: EmbeddingProvider;
  private config: EmbeddingConfig;

  constructor(private configService: ConfigService) {
    this.config = this.loadConfig();
    this.provider = this.createProvider();
    this.logger.log(`Initialized embedding service with provider: ${this.provider.name}`);
  }

  private loadConfig(): EmbeddingConfig {
    const providerEnv = this.configService.get('EMBEDDING_PROVIDER');
    const modelEnv = this.configService.get('EMBEDDING_MODEL');
    const dimensionsEnv = this.configService.get('EMBEDDING_DIMENSIONS');
    const provider = (providerEnv as EmbeddingConfig['provider']) ?? DEFAULT_EMBEDDING_CONFIG.provider;

    // Get the appropriate API key based on provider
    let apiKey: string | undefined;
    if (provider === 'voyage') {
      apiKey = this.configService.get('VOYAGE_API_KEY') as string | undefined;
    } else if (provider === 'openai') {
      apiKey = this.configService.get('OPENAI_API_KEY') as string | undefined;
    }

    return {
      provider,
      apiKey,
      model: (modelEnv as string) ?? DEFAULT_EMBEDDING_CONFIG.model,
      dimensions: dimensionsEnv ? Number(dimensionsEnv) : DEFAULT_EMBEDDING_CONFIG.dimensions,
    };
  }

  private createProvider(): EmbeddingProvider {
    switch (this.config.provider) {
      case 'openai':
        if (!this.config.apiKey) {
          throw new Error(
            'OPENAI_API_KEY environment variable is required for embeddings. ' +
            'Set it in packages/graph/.env or use --no-embeddings to skip embedding generation.'
          );
        }
        return new OpenAIEmbeddingProvider({
          apiKey: this.config.apiKey,
          model: this.config.model,
          dimensions: this.config.dimensions,
        });
      case 'mock':
        // Only use mock when explicitly requested (for testing)
        return new MockEmbeddingProvider(this.config.dimensions);
      case 'voyage':
        if (!this.config.apiKey) {
          throw new Error(
            'VOYAGE_API_KEY environment variable is required for embeddings. ' +
            'Set it in packages/graph/.env or use --no-embeddings to skip embedding generation.'
          );
        }
        return new VoyageEmbeddingProvider({
          apiKey: this.config.apiKey,
          model: this.config.model,
          dimensions: this.config.dimensions,
        });
      case 'nomic':
        throw new Error(`Provider ${this.config.provider} not yet implemented. Use 'voyage', 'openai', or 'mock'.`);
      default:
        throw new Error(`Unknown embedding provider: ${this.config.provider}. Use 'voyage', 'openai', or 'mock'.`);
    }
  }

  /**
   * Get the current provider name
   */
  getProviderName(): string {
    return this.provider.name;
  }

  /**
   * Get embedding dimensions
   */
  getDimensions(): number {
    return this.provider.dimensions;
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('Cannot generate embedding for empty text');
    }
    return this.provider.generateEmbedding(text);
  }

  /**
   * Generate embeddings for multiple texts
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const validTexts = texts.filter(t => t && t.trim().length > 0);
    if (validTexts.length === 0) {
      return [];
    }
    return this.provider.generateEmbeddings(validTexts);
  }

  /**
   * Check if the service is configured for real embeddings (not mock)
   */
  isRealProvider(): boolean {
    return this.provider.name !== 'mock';
  }
}
