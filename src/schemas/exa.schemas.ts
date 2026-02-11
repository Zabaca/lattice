import { z } from "zod";

/**
 * Exa API search response schema
 */
export const ExaSearchResultSchema = z.object({
	title: z.string(),
	url: z.string(),
	publishedDate: z.string().nullish(),
	author: z.string().nullish(),
	score: z.number().optional(),
	text: z.string().nullish(),
	highlights: z.array(z.string()).nullish(),
	summary: z.string().nullish(),
});

export const ExaSearchResponseSchema = z.object({
	requestId: z.string().optional(),
	results: z.array(ExaSearchResultSchema),
	autopromptString: z.string().optional(),
});

export type ExaSearchResponseType = z.infer<typeof ExaSearchResponseSchema>;
