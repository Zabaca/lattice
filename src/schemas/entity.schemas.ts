import { z } from "zod";

/**
 * Valid entity property values for graph node properties
 * Replaces Record<string, any> with type-safe schema
 */
export const EntityPropertyValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(z.string()),
]);

export type EntityPropertyValue = z.infer<typeof EntityPropertyValueSchema>;

/**
 * Type-safe entity properties map
 * Use instead of Record<string, any> for graph node properties
 */
export type EntityProperties = Record<string, EntityPropertyValue>;

/**
 * Cypher query execution statistics
 */
export const CypherStatsSchema = z.object({
	nodesCreated: z.number().default(0),
	nodesDeleted: z.number().default(0),
	relationshipsCreated: z.number().default(0),
	relationshipsDeleted: z.number().default(0),
	propertiesSet: z.number().default(0),
});

export type CypherStats = z.infer<typeof CypherStatsSchema>;
