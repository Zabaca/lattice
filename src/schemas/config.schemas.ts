import { z } from "zod";

/**
 * DuckDB connection configuration schema
 *
 * Note: Database path is now fixed at ~/.lattice/lattice.duckdb
 * See src/utils/paths.ts for path utilities.
 */
export const DuckDBConfigSchema = z.object({
	embeddingDimensions: z.coerce.number().int().positive().default(512),
});

export type DuckDBConfig = z.infer<typeof DuckDBConfigSchema>;

/**
 * Embedding service configuration schema
 */
export const EmbeddingConfigSchema = z.object({
	provider: z.enum(["openai", "voyage", "nomic", "mock"]).default("voyage"),
	// apiKey validation (empty check) is done in EmbeddingService.createProvider()
	// for user-friendly error messages
	apiKey: z.string().optional(),
	model: z.string().min(1).default("voyage-3.5-lite"),
	dimensions: z.coerce.number().int().positive().default(512),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
