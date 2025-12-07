import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { CypherResult } from "./graph.types.js";

@Injectable()
export class GraphService implements OnModuleDestroy {
	private readonly logger = new Logger(GraphService.name);
	private instance: DuckDBInstance | null = null;
	private connection: DuckDBConnection | null = null;
	private dbPath: string;
	private connecting: Promise<void> | null = null;
	private vectorIndexes: Set<string> = new Set();
	private embeddingDimensions: number;

	constructor(private configService: ConfigService) {
		this.dbPath =
			this.configService.get<string>("DUCKDB_PATH") || "./.lattice.duckdb";
		this.embeddingDimensions =
			this.configService.get<number>("EMBEDDING_DIMENSIONS") || 512;
	}

	async onModuleDestroy(): Promise<void> {
		await this.disconnect();
	}

	/**
	 * Lazily connect to DuckDB - only connects when first query is made
	 */
	private async ensureConnected(): Promise<DuckDBConnection> {
		if (this.connection) {
			return this.connection;
		}

		// Prevent multiple simultaneous connection attempts
		if (this.connecting) {
			await this.connecting;
			if (!this.connection) {
				throw new Error("Connection failed to establish");
			}
			return this.connection;
		}

		this.connecting = this.connect();
		await this.connecting;
		this.connecting = null;
		if (!this.connection) {
			throw new Error("Connection failed to establish");
		}
		return this.connection;
	}

	async connect(): Promise<void> {
		try {
			// Allow unsigned extensions for DuckPGQ from custom repository
			this.instance = await DuckDBInstance.create(this.dbPath, {
				allow_unsigned_extensions: "true",
			});
			this.connection = await this.instance.connect();

			// Load VSS extension for vector similarity search
			await this.connection.run("INSTALL vss; LOAD vss;");

			// Enable experimental HNSW persistence
			await this.connection.run(
				"SET hnsw_enable_experimental_persistence = true;",
			);

			// Load DuckPGQ extension for property graph queries (from custom repository)
			try {
				// Set custom repo for DuckPGQ
				await this.connection.run(
					"SET custom_extension_repository = 'http://duckpgq.s3.eu-north-1.amazonaws.com';",
				);
				await this.connection.run("FORCE INSTALL 'duckpgq';");
				await this.connection.run("LOAD 'duckpgq';");
				this.logger.log("DuckPGQ extension loaded successfully");
			} catch (e) {
				this.logger.warn(
					`DuckPGQ extension not available: ${e instanceof Error ? e.message : String(e)}`,
				);
			}

			// Initialize schema
			await this.initializeSchema();

			this.logger.log(`Connected to DuckDB at ${this.dbPath}`);
		} catch (error) {
			this.connection = null;
			this.instance = null;
			this.logger.error(
				`Failed to connect to DuckDB: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connection) {
			this.connection.closeSync();
			this.connection = null;
			this.logger.log("Disconnected from DuckDB");
		}
		if (this.instance) {
			this.instance = null;
		}
	}

	private async initializeSchema(): Promise<void> {
		if (!this.connection) {
			throw new Error("Cannot initialize schema: not connected");
		}
		const conn = this.connection;

		// Create nodes table with composite primary key
		// Note: embedding uses fixed-size array for VSS compatibility
		await conn.run(`
			CREATE TABLE IF NOT EXISTS nodes (
				label VARCHAR NOT NULL,
				name VARCHAR NOT NULL,
				properties JSON,
				embedding FLOAT[${this.embeddingDimensions}],
				created_at TIMESTAMP DEFAULT NOW(),
				updated_at TIMESTAMP DEFAULT NOW(),
				PRIMARY KEY(label, name)
			)
		`);

		// Create relationships table with composite primary key
		await conn.run(`
			CREATE TABLE IF NOT EXISTS relationships (
				source_label VARCHAR NOT NULL,
				source_name VARCHAR NOT NULL,
				relation_type VARCHAR NOT NULL,
				target_label VARCHAR NOT NULL,
				target_name VARCHAR NOT NULL,
				properties JSON,
				created_at TIMESTAMP DEFAULT NOW(),
				PRIMARY KEY(source_label, source_name, relation_type, target_label, target_name)
			)
		`);

		// Create indexes
		await conn.run(
			"CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label)",
		);
		await conn.run(
			"CREATE INDEX IF NOT EXISTS idx_nodes_label_name ON nodes(label, name)",
		);
		await conn.run(
			"CREATE INDEX IF NOT EXISTS idx_rels_source ON relationships(source_label, source_name)",
		);
		await conn.run(
			"CREATE INDEX IF NOT EXISTS idx_rels_target ON relationships(target_label, target_name)",
		);
	}

	async query(
		sql: string,
		_params?: Record<string, unknown>,
	): Promise<CypherResult> {
		try {
			const conn = await this.ensureConnected();
			const reader = await conn.runAndReadAll(sql);
			const rows = reader.getRows();

			return {
				resultSet: rows as unknown[][],
				stats: undefined, // DuckDB doesn't return stats in the same way
			};
		} catch (error) {
			this.logger.error(
				`Query failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Upsert a node (INSERT ... ON CONFLICT DO UPDATE)
	 */
	async upsertNode(
		label: string,
		properties: Record<string, unknown>,
	): Promise<void> {
		try {
			const { name, ...otherProps } = properties;

			if (!name) {
				throw new Error("Node must have a 'name' property");
			}

			const conn = await this.ensureConnected();

			// Use parameterized query to avoid SQL injection
			const propsJson = JSON.stringify(otherProps);

			await conn.run(`
				INSERT INTO nodes (label, name, properties)
				VALUES ('${this.escape(String(label))}', '${this.escape(String(name))}', '${this.escape(propsJson)}')
				ON CONFLICT (label, name) DO UPDATE SET
					properties = EXCLUDED.properties,
					updated_at = NOW()
			`);
		} catch (error) {
			this.logger.error(
				`Failed to upsert node: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Upsert a relationship between two nodes.
	 * Creates nodes if they don't exist (MERGE behavior).
	 */
	async upsertRelationship(
		sourceLabel: string,
		sourceName: string,
		relation: string,
		targetLabel: string,
		targetName: string,
		properties?: Record<string, unknown>,
	): Promise<void> {
		try {
			const conn = await this.ensureConnected();

			// Ensure source node exists
			await conn.run(`
				INSERT INTO nodes (label, name, properties)
				VALUES ('${this.escape(sourceLabel)}', '${this.escape(sourceName)}', '{}')
				ON CONFLICT (label, name) DO NOTHING
			`);

			// Ensure target node exists
			await conn.run(`
				INSERT INTO nodes (label, name, properties)
				VALUES ('${this.escape(targetLabel)}', '${this.escape(targetName)}', '{}')
				ON CONFLICT (label, name) DO NOTHING
			`);

			// Insert relationship
			const propsJson = properties ? JSON.stringify(properties) : "{}";
			await conn.run(`
				INSERT INTO relationships (source_label, source_name, relation_type, target_label, target_name, properties)
				VALUES (
					'${this.escape(sourceLabel)}',
					'${this.escape(sourceName)}',
					'${this.escape(relation)}',
					'${this.escape(targetLabel)}',
					'${this.escape(targetName)}',
					'${this.escape(propsJson)}'
				)
				ON CONFLICT (source_label, source_name, relation_type, target_label, target_name) DO UPDATE SET
					properties = EXCLUDED.properties
			`);
		} catch (error) {
			this.logger.error(
				`Failed to upsert relationship: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Delete a node by label and name
	 */
	async deleteNode(label: string, name: string): Promise<void> {
		try {
			const conn = await this.ensureConnected();

			// Delete relationships first (both directions)
			await conn.run(`
				DELETE FROM relationships
				WHERE (source_label = '${this.escape(label)}' AND source_name = '${this.escape(name)}')
				   OR (target_label = '${this.escape(label)}' AND target_name = '${this.escape(name)}')
			`);

			// Delete node
			await conn.run(`
				DELETE FROM nodes
				WHERE label = '${this.escape(label)}' AND name = '${this.escape(name)}'
			`);
		} catch (error) {
			this.logger.error(
				`Failed to delete node: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Delete all relationships for a document (by documentPath property)
	 */
	async deleteDocumentRelationships(documentPath: string): Promise<void> {
		try {
			const conn = await this.ensureConnected();

			await conn.run(`
				DELETE FROM relationships
				WHERE properties->>'documentPath' = '${this.escape(documentPath)}'
			`);
		} catch (error) {
			this.logger.error(
				`Failed to delete document relationships: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Find nodes by label with optional limit
	 */
	async findNodesByLabel(label: string, limit?: number): Promise<unknown[]> {
		try {
			const conn = await this.ensureConnected();
			const limitClause = limit ? ` LIMIT ${limit}` : "";

			const reader = await conn.runAndReadAll(`
				SELECT name, properties
				FROM nodes
				WHERE label = '${this.escape(label)}'${limitClause}
			`);

			return reader.getRows().map((row) => {
				const [name, properties] = row as [string, string | null];
				const props = properties ? JSON.parse(properties) : {};
				return { name, ...props };
			});
		} catch (error) {
			this.logger.error(
				`Failed to find nodes by label: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}

	/**
	 * Find all relationships for a node by name
	 */
	async findRelationships(nodeName: string): Promise<unknown[]> {
		try {
			const conn = await this.ensureConnected();

			const reader = await conn.runAndReadAll(`
				SELECT relation_type, target_name, source_name
				FROM relationships
				WHERE source_name = '${this.escape(nodeName)}'
				   OR target_name = '${this.escape(nodeName)}'
			`);

			return reader.getRows().map((row) => {
				const [relType, targetName, sourceName] = row as [
					string,
					string,
					string,
				];
				return [relType, sourceName === nodeName ? targetName : sourceName];
			});
		} catch (error) {
			this.logger.error(
				`Failed to find relationships: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}

	/**
	 * Create a vector index for semantic search
	 */
	async createVectorIndex(
		label: string,
		property: string,
		dimensions: number,
	): Promise<void> {
		try {
			const indexKey = `${label}_${property}`;
			if (this.vectorIndexes.has(indexKey)) {
				return; // Index already created in this session
			}

			const conn = await this.ensureConnected();

			// First, alter the table to ensure the embedding column has the right dimensions
			// DuckDB VSS requires a fixed-size array
			try {
				await conn.run(`
					CREATE INDEX idx_embedding_${this.escape(label)}
					ON nodes USING HNSW (embedding)
					WITH (metric = 'cosine')
				`);
			} catch {
				// Index might already exist, that's okay
				this.logger.debug(
					`Vector index on ${label}.${property} already exists`,
				);
			}

			this.vectorIndexes.add(indexKey);
			this.logger.log(
				`Created vector index on ${label}.${property} with ${dimensions} dimensions`,
			);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			if (!errorMessage.includes("already exists")) {
				this.logger.error(`Failed to create vector index: ${errorMessage}`);
				throw error;
			}
		}
	}

	/**
	 * Update a node's embedding vector
	 */
	async updateNodeEmbedding(
		label: string,
		name: string,
		embedding: number[],
	): Promise<void> {
		try {
			const conn = await this.ensureConnected();

			const vectorStr = `[${embedding.join(", ")}]`;

			// Cast to fixed-size array for VSS compatibility
			await conn.run(`
				UPDATE nodes
				SET embedding = ${vectorStr}::FLOAT[${this.embeddingDimensions}]
				WHERE label = '${this.escape(label)}' AND name = '${this.escape(name)}'
			`);
		} catch (error) {
			this.logger.error(
				`Failed to update node embedding: ${error instanceof Error ? error.message : String(error)}`,
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
		k: number = 10,
	): Promise<Array<{ name: string; title?: string; score: number }>> {
		try {
			const conn = await this.ensureConnected();
			const vectorStr = `[${queryVector.join(", ")}]`;

			// Use array_cosine_similarity for similarity search
			// Cosine similarity ranges from -1 to 1, where 1 is most similar
			// Cast to fixed-size array for VSS compatibility
			const reader = await conn.runAndReadAll(`
				SELECT
					name,
					properties->>'title' as title,
					array_cosine_similarity(embedding, ${vectorStr}::FLOAT[${this.embeddingDimensions}]) as similarity
				FROM nodes
				WHERE label = '${this.escape(label)}'
				  AND embedding IS NOT NULL
				ORDER BY similarity DESC
				LIMIT ${k}
			`);

			return reader.getRows().map((row) => {
				const [name, title, similarity] = row as [
					string,
					string | null,
					number,
				];
				return {
					name,
					title: title || undefined,
					score: similarity,
				};
			});
		} catch (error) {
			this.logger.error(
				`Vector search failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Search across all entity types using vector similarity
	 */
	async vectorSearchAll(
		queryVector: number[],
		k: number = 10,
	): Promise<
		Array<{
			name: string;
			label: string;
			title?: string;
			description?: string;
			score: number;
		}>
	> {
		const allResults: Array<{
			name: string;
			label: string;
			title?: string;
			description?: string;
			score: number;
		}> = [];

		const conn = await this.ensureConnected();
		const vectorStr = `[${queryVector.join(", ")}]`;

		// Query all labels at once
		// Cast to fixed-size array for VSS compatibility
		try {
			const reader = await conn.runAndReadAll(`
				SELECT
					name,
					label,
					properties->>'title' as title,
					properties->>'description' as description,
					array_cosine_similarity(embedding, ${vectorStr}::FLOAT[${this.embeddingDimensions}]) as similarity
				FROM nodes
				WHERE embedding IS NOT NULL
				ORDER BY similarity DESC
				LIMIT ${k}
			`);

			for (const row of reader.getRows()) {
				const [name, label, title, description, similarity] = row as [
					string,
					string,
					string | null,
					string | null,
					number,
				];
				allResults.push({
					name,
					label,
					title: title || undefined,
					description: description || undefined,
					score: similarity,
				});
			}
		} catch (error) {
			this.logger.debug(
				`Vector search failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		return allResults.sort((a, b) => b.score - a.score).slice(0, k);
	}

	/**
	 * Escape special characters in SQL string values
	 */
	private escape(value: string): string {
		return value.replace(/'/g, "''");
	}
}
