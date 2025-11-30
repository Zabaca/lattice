import { z } from "zod";

/**
 * FalkorDB connection configuration schema
 */
export const FalkorDBConfigSchema = z.object({
	host: z.string().min(1).default("localhost"),
	port: z.coerce.number().int().positive().default(6379),
	graphName: z.string().min(1).default("research_knowledge"),
});

export type FalkorDBConfig = z.infer<typeof FalkorDBConfigSchema>;

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
