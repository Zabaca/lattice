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
