import { Injectable, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type {
	FalkorDBConfig,
	CypherResult,
} from "./graph.types.js";

@Injectable()
export class GraphService implements OnModuleDestroy {
	private readonly logger = new Logger(GraphService.name);
	private redis: Redis | null = null;
	private config: FalkorDBConfig;
	private connecting: Promise<void> | null = null;

	constructor(private configService: ConfigService) {
		this.config = {
			host: this.configService.get<string>(
				"FALKORDB_HOST",
				"localhost"
			),
			port: this.configService.get<number>("FALKORDB_PORT", 6379),
			graphName: this.configService.get<string>(
				"GRAPH_NAME",
				"research_knowledge"
			),
		};
	}

	async onModuleDestroy(): Promise<void> {
		await this.disconnect();
	}

	/**
	 * Lazily connect to FalkorDB - only connects when first query is made
	 */
	private async ensureConnected(): Promise<Redis> {
		if (this.redis) {
			return this.redis;
		}

		// Prevent multiple simultaneous connection attempts
		if (this.connecting) {
			await this.connecting;
			return this.redis!;
		}

		this.connecting = this.connect();
		await this.connecting;
		this.connecting = null;
		return this.redis!;
	}

	async connect(): Promise<void> {
		try {
			this.redis = new Redis({
				host: this.config.host,
				port: this.config.port,
				maxRetriesPerRequest: 3,
				retryStrategy: (times: number) => {
					if (times > 3) {
						return null; // Stop retrying
					}
					const delay = Math.min(times * 50, 2000);
					return delay;
				},
				lazyConnect: true, // Don't connect until first command
			});

			// Suppress unhandled error events (we handle errors in queries)
			this.redis.on("error", (err) => {
				this.logger.debug(`Redis connection error: ${err.message}`);
			});

			// Test connection
			await this.redis.ping();
			this.logger.log(
				`Connected to FalkorDB at ${this.config.host}:${this.config.port}`
			);
		} catch (error) {
			this.redis = null;
			this.logger.error(
				`Failed to connect to FalkorDB: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	async disconnect(): Promise<void> {
		if (this.redis) {
			await this.redis.quit();
			this.logger.log("Disconnected from FalkorDB");
		}
	}

	async query(cypher: string, _params?: Record<string, any>): Promise<CypherResult> {
		try {
			const redis = await this.ensureConnected();
			const result = await redis.call(
				"GRAPH.QUERY",
				this.config.graphName,
				cypher
			);

			// FalkorDB returns: [headers, rows, stats]
			// - result[0] = column headers (e.g., ["count"])
			// - result[1] = data rows (e.g., [[0], [1]])
			// - result[2] = execution stats
			const resultArray = Array.isArray(result) ? result : [];
			return {
				resultSet: (Array.isArray(resultArray[1]) ? resultArray[1] : []) as unknown[][],
				stats: this.parseStats(result),
			};
		} catch (error) {
			this.logger.error(
				`Cypher query failed: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	/**
	 * Upsert a node (MERGE by name + type)
	 */
	async upsertNode(label: string, properties: Record<string, any>): Promise<void> {
		try {
			const { name, ...otherProps } = properties;

			if (!name) {
				throw new Error("Node must have a 'name' property");
			}

			const escapedName = this.escapeCypher(String(name));
			const escapedLabel = this.escapeCypher(label);

			// Build property assignments
			const propAssignments = Object.entries({
				name,
				...otherProps,
			})
				.map(([key, value]) => {
					const escapedKey = this.escapeCypher(key);
					const escapedValue = this.escapeCypherValue(value);
					return `n.\`${escapedKey}\` = ${escapedValue}`;
				})
				.join(", ");

			const cypher =
				`MERGE (n:\`${escapedLabel}\` { name: '${escapedName}' }) ` +
				`SET ${propAssignments}`;

			await this.query(cypher);
		} catch (error) {
			this.logger.error(
				`Failed to upsert node: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	/**
	 * Upsert a relationship between two nodes.
	 * Uses MERGE for both nodes to ensure they exist before creating the relationship.
	 * This prevents silent failures when nodes don't exist.
	 */
	async upsertRelationship(
		sourceLabel: string,
		sourceName: string,
		relation: string,
		targetLabel: string,
		targetName: string,
		properties?: Record<string, any>
	): Promise<void> {
		try {
			const escapedSourceLabel = this.escapeCypher(sourceLabel);
			const escapedSourceName = this.escapeCypher(sourceName);
			const escapedRelation = this.escapeCypher(relation);
			const escapedTargetLabel = this.escapeCypher(targetLabel);
			const escapedTargetName = this.escapeCypher(targetName);

			// Build relationship property assignments if provided
			let relPropAssignments = "";
			if (properties && Object.keys(properties).length > 0) {
				relPropAssignments = ` SET ` +
					Object.entries(properties)
						.map(([key, value]) => {
							const escapedKey = this.escapeCypher(key);
							const escapedValue = this.escapeCypherValue(value);
							return `r.\`${escapedKey}\` = ${escapedValue}`;
						})
						.join(", ");
			}

			// Use MERGE for both nodes to ensure they exist
			// This prevents silent failures when MATCH finds no nodes
			const cypher =
				`MERGE (source:\`${escapedSourceLabel}\` { name: '${escapedSourceName}' }) ` +
				`MERGE (target:\`${escapedTargetLabel}\` { name: '${escapedTargetName}' }) ` +
				`MERGE (source)-[r:\`${escapedRelation}\`]->(target)` +
				relPropAssignments;

			await this.query(cypher);
		} catch (error) {
			this.logger.error(
				`Failed to upsert relationship: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	/**
	 * Delete a node by label and name
	 */
	async deleteNode(label: string, name: string): Promise<void> {
		try {
			const escapedLabel = this.escapeCypher(label);
			const escapedName = this.escapeCypher(name);

			const cypher =
				`MATCH (n:\`${escapedLabel}\` { name: '${escapedName}' }) ` +
				`DETACH DELETE n`;

			await this.query(cypher);
		} catch (error) {
			this.logger.error(
				`Failed to delete node: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	/**
	 * Delete all relationships for a document (by documentPath property)
	 */
	async deleteDocumentRelationships(documentPath: string): Promise<void> {
		try {
			const escapedPath = this.escapeCypher(documentPath);

			const cypher =
				`MATCH ()-[r { documentPath: '${escapedPath}' }]-() ` +
				`DELETE r`;

			await this.query(cypher);
		} catch (error) {
			this.logger.error(
				`Failed to delete document relationships: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	/**
	 * Find nodes by label with optional limit
	 */
	async findNodesByLabel(label: string, limit?: number): Promise<any[]> {
		try {
			const escapedLabel = this.escapeCypher(label);
			const limitClause = limit ? ` LIMIT ${limit}` : "";

			const cypher =
				`MATCH (n:\`${escapedLabel}\`) RETURN n${limitClause}`;

			const result = await this.query(cypher);
			return (result.resultSet || []).map((row) => row[0]);
		} catch (error) {
			this.logger.error(
				`Failed to find nodes by label: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	/**
	 * Find all relationships for a node by name
	 */
	async findRelationships(nodeName: string): Promise<any[]> {
		try {
			const escapedName = this.escapeCypher(nodeName);

			const cypher =
				`MATCH (n { name: '${escapedName}' })-[r]-(m) ` +
				`RETURN type(r), m.name`;

			const result = await this.query(cypher);
			return result.resultSet || [];
		} catch (error) {
			this.logger.error(
				`Failed to find relationships: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	/**
	 * Create a vector index for semantic search
	 * FalkorDB uses HNSW indexing for vector similarity
	 */
	async createVectorIndex(
		label: string,
		property: string,
		dimensions: number
	): Promise<void> {
		try {
			const escapedLabel = this.escapeCypher(label);
			const escapedProperty = this.escapeCypher(property);

			// FalkorDB vector index creation syntax
			// See: https://docs.falkordb.com/commands/graph.query.html#vector-indexing
			const cypher = `CREATE VECTOR INDEX FOR (n:\`${escapedLabel}\`) ON (n.\`${escapedProperty}\`) OPTIONS { dimension: ${dimensions}, similarityFunction: 'cosine' }`;

			await this.query(cypher);
			this.logger.log(`Created vector index on ${label}.${property} with ${dimensions} dimensions`);
		} catch (error) {
			// Index might already exist, that's okay
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (!errorMessage.includes('already indexed')) {
				this.logger.error(`Failed to create vector index: ${errorMessage}`);
				throw error;
			}
			this.logger.debug(`Vector index on ${label}.${property} already exists`);
		}
	}

	/**
	 * Update a node's embedding vector
	 */
	async updateNodeEmbedding(
		label: string,
		name: string,
		embedding: number[]
	): Promise<void> {
		try {
			const escapedLabel = this.escapeCypher(label);
			const escapedName = this.escapeCypher(name);

			// FalkorDB stores vectors as arrays
			const vectorStr = `[${embedding.join(', ')}]`;

			const cypher =
				`MATCH (n:\`${escapedLabel}\` { name: '${escapedName}' }) ` +
				`SET n.embedding = vecf32(${vectorStr})`;

			await this.query(cypher);
		} catch (error) {
			this.logger.error(
				`Failed to update node embedding: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	/**
	 * Search for similar nodes using vector similarity (KNN)
	 */
	async vectorSearch(
		label: string,
		queryVector: number[],
		k: number = 10
	): Promise<Array<{ name: string; title?: string; score: number }>> {
		try {
			const escapedLabel = this.escapeCypher(label);
			const vectorStr = `[${queryVector.join(', ')}]`;

			// FalkorDB KNN vector search using vec.queryNodes
			// FalkorDB returns distance (lower = better), normalize to similarity (higher = better)
			// Formula: (2 - distance) / 2 converts cosine distance to similarity
			const cypher =
				`CALL db.idx.vector.queryNodes('${escapedLabel}', 'embedding', ${k}, vecf32(${vectorStr})) ` +
				`YIELD node, score ` +
				`RETURN node.name AS name, node.title AS title, (2 - score) / 2 AS similarity ` +
				`ORDER BY similarity DESC`;

			const result = await this.query(cypher);

			return (result.resultSet || []).map((row) => ({
				name: row[0] as string,
				title: row[1] as string | undefined,
				score: row[2] as number,
			}));
		} catch (error) {
			this.logger.error(
				`Vector search failed: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	/**
	 * Search across all entity types using vector similarity
	 * Queries each label's index and merges results sorted by score
	 */
	async vectorSearchAll(
		queryVector: number[],
		k: number = 10
	): Promise<Array<{ name: string; label: string; title?: string; description?: string; score: number }>> {
		const allLabels = ['Document', 'Concept', 'Process', 'Tool', 'Technology', 'Organization', 'Topic', 'Person'];
		const allResults: Array<{ name: string; label: string; title?: string; description?: string; score: number }> = [];

		// Query each label's vector index
		for (const label of allLabels) {
			try {
				const escapedLabel = this.escapeCypher(label);
				const vectorStr = `[${queryVector.join(', ')}]`;

				// FalkorDB returns distance (lower = better), normalize to similarity (higher = better)
				const cypher =
					`CALL db.idx.vector.queryNodes('${escapedLabel}', 'embedding', ${k}, vecf32(${vectorStr})) ` +
					`YIELD node, score ` +
					`RETURN node.name AS name, node.title AS title, node.description AS description, (2 - score) / 2 AS similarity ` +
					`ORDER BY similarity DESC`;

				const result = await this.query(cypher);
				const labelResults = (result.resultSet || []).map((row) => ({
					name: row[0] as string,
					label,
					title: row[1] as string | undefined,
					description: row[2] as string | undefined,
					score: row[3] as number,
				}));
				allResults.push(...labelResults);
			} catch (error) {
				// Some labels might not have indices, skip them
				this.logger.debug(`Vector search for ${label} skipped: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		// Sort by score descending and return top k
		return allResults
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}

	/**
	 * Escape special characters in Cypher string values
	 */
	private escapeCypher(value: string): string {
		return value
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "\\'")
			.replace(/"/g, '\\"');
	}

	/**
	 * Escape and format a value for Cypher
	 */
	private escapeCypherValue(value: any): string {
		if (value === null || value === undefined) {
			return "null";
		}

		if (typeof value === "string") {
			const escaped = this.escapeCypher(value);
			return `'${escaped}'`;
		}

		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}

		if (Array.isArray(value)) {
			return `[${value.map((v) => this.escapeCypherValue(v)).join(", ")}]`;
		}

		if (typeof value === "object") {
			const pairs = Object.entries(value)
				.map(([k, v]) => `${k}: ${this.escapeCypherValue(v)}`)
				.join(", ");
			return `{${pairs}}`;
		}

		return String(value);
	}

	private parseStats(result: unknown): CypherResult["stats"] | undefined {
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
		const stats: CypherResult["stats"] = {
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

		const relCreatedMatch = statsStr.match(
			/Relationships created: (\d+)/
		);
		if (relCreatedMatch) {
			stats.relationshipsCreated = parseInt(relCreatedMatch[1], 10);
		}

		const relDeletedMatch = statsStr.match(
			/Relationships deleted: (\d+)/
		);
		if (relDeletedMatch) {
			stats.relationshipsDeleted = parseInt(relDeletedMatch[1], 10);
		}

		const propSetMatch = statsStr.match(/Properties set: (\d+)/);
		if (propSetMatch) {
			stats.propertiesSet = parseInt(propSetMatch[1], 10);
		}

		return stats;
	}
}
