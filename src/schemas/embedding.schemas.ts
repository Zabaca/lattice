import { z } from "zod";

/**
 * Voyage AI embedding response schema
 */
export const VoyageEmbeddingResponseSchema = z.object({
	object: z.string(),
	data: z.array(
		z.object({
			object: z.string(),
			embedding: z.array(z.number()),
			index: z.number().int().nonnegative(),
		}),
	),
	model: z.string(),
	usage: z.object({
		total_tokens: z.number().int().nonnegative(),
	}),
});

export type VoyageEmbeddingResponse = z.infer<
	typeof VoyageEmbeddingResponseSchema
>;
