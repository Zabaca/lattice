import { z } from "zod";

/**
 * DuckDB connection configuration schema
 */
export const DuckDBConfigSchema = z.object({
	dbPath: z.string().optional(), // Default: ./.lattice.duckdb
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

/**
 * Document paths configuration schema
 */
export const DocsConfigSchema = z.object({
	projectRoot: z.string().default(process.cwd()),
	docsPath: z.string().default("docs"),
});

export type DocsConfig = z.infer<typeof DocsConfigSchema>;
