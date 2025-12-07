import { z } from "zod";

/**
 * DuckDB SQL query result schema
 */
export const SqlResultSchema = z.object({
	resultSet: z.array(z.array(z.unknown())),
	stats: z.undefined().optional(), // DuckDB doesn't return stats like FalkorDB
});

export type SqlResult = z.infer<typeof SqlResultSchema>;

// Backward compatibility alias
export const CypherResultSchema = SqlResultSchema;
export type CypherResult = SqlResult;
