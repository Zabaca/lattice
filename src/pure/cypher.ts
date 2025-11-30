/**
 * Pure functions for Cypher query building and escaping
 * Extracted from GraphService for testability without mocks
 */
import type {
	CypherStats,
	EntityProperties,
} from "../schemas/entity.schemas.js";

/**
 * Escape special characters in Cypher string values
 */
export function escapeCypher(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/**
 * Escape and format a value for Cypher
 * Handles strings, numbers, booleans, arrays, objects, and null
 */
export function escapeCypherValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "null";
	}

	if (typeof value === "string") {
		const escaped = escapeCypher(value);
		return `'${escaped}'`;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((v) => escapeCypherValue(v)).join(", ")}]`;
	}

	if (typeof value === "object") {
		const pairs = Object.entries(value)
			.map(([k, v]) => `${k}: ${escapeCypherValue(v)}`)
			.join(", ");
		return `{${pairs}}`;
	}

	return String(value);
}

/**
 * Build property assignments for SET clause
 * @param props Entity properties to set
 * @param nodeVar Variable name for the node (default: 'n')
 */
export function buildPropertyAssignments(
	props: EntityProperties,
	nodeVar = "n",
): string {
	return Object.entries(props)
		.map(([key, value]) => {
			const escapedKey = escapeCypher(key);
			const escapedValue = escapeCypherValue(value);
			return `${nodeVar}.\`${escapedKey}\` = ${escapedValue}`;
		})
		.join(", ");
}

/**
 * Parse FalkorDB stats string into structured object
 * FalkorDB returns: [headers, rows, stats_string]
 */
export function parseStats(result: unknown): CypherStats | undefined {
	// FalkorDB returns: [headers, rows, stats]
	// Statistics is the last element (index 2 for 3-element array)
	if (!Array.isArray(result) || result.length < 3) {
		return undefined;
	}

	const statsStr = result[2] as string | undefined;
	if (!statsStr || typeof statsStr !== "string") {
		return undefined;
	}

	// Parse FalkorDB stats string format
	const stats: CypherStats = {
		nodesCreated: 0,
		nodesDeleted: 0,
		relationshipsCreated: 0,
		relationshipsDeleted: 0,
		propertiesSet: 0,
	};

	// Extract values from stats string (e.g., "Nodes created: 1, Properties set: 2")
	const nodeCreatedMatch = statsStr.match(/Nodes created: (\d+)/);
	if (nodeCreatedMatch) {
		stats.nodesCreated = parseInt(nodeCreatedMatch[1], 10);
	}

	const nodeDeletedMatch = statsStr.match(/Nodes deleted: (\d+)/);
	if (nodeDeletedMatch) {
		stats.nodesDeleted = parseInt(nodeDeletedMatch[1], 10);
	}

	const relCreatedMatch = statsStr.match(/Relationships created: (\d+)/);
	if (relCreatedMatch) {
		stats.relationshipsCreated = parseInt(relCreatedMatch[1], 10);
	}

	const relDeletedMatch = statsStr.match(/Relationships deleted: (\d+)/);
	if (relDeletedMatch) {
		stats.relationshipsDeleted = parseInt(relDeletedMatch[1], 10);
	}

	const propSetMatch = statsStr.match(/Properties set: (\d+)/);
	if (propSetMatch) {
		stats.propertiesSet = parseInt(propSetMatch[1], 10);
	}

	return stats;
}
