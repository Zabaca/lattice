import { z } from "zod";

/**
 * FalkorDB Cypher query result schema
 */
export const CypherResultSchema = z.object({
	resultSet: z.array(z.array(z.unknown())),
	stats: z
		.object({
			nodesCreated: z.number(),
			nodesDeleted: z.number(),
			relationshipsCreated: z.number(),
			relationshipsDeleted: z.number(),
			propertiesSet: z.number(),
		})
		.optional(),
});

export type CypherResult = z.infer<typeof CypherResultSchema>;
