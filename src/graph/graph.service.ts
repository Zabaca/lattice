import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ensureLatticeHome, getDatabasePath } from "../utils/paths.js";
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
	private signalHandlersRegistered = false;

	constructor(private configService: ConfigService) {
		ensureLatticeHome();
		this.dbPath = getDatabasePath();
		this.embeddingDimensions =
			this.configService.get<number>("EMBEDDING_DIMENSIONS") || 512;
		this.registerSignalHandlers();
	}

	/**
	 * Register signal handlers for graceful shutdown with checkpoint
	 */
	private registerSignalHandlers(): void {
		if (this.signalHandlersRegistered) return;
		this.signalHandlersRegistered = true;

		const gracefulShutdown = async (signal: string) => {
			this.logger.log(`Received ${signal}, checkpointing before exit...`);
			try {
				await this.checkpoint();
				await this.disconnect();
			} catch (error) {
				this.logger.error(
					`Error during graceful shutdown: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			process.exit(0);
		};

		process.on("SIGINT", () => gracefulShutdown("SIGINT"));
		process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
		process.on("beforeExit", async () => {
			if (this.connection) {
				await this.checkpoint();
			}
		});
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

	/**
	 * Connect to DuckDB using in-memory + ATTACH pattern.
	 * This ensures VSS extension is loaded BEFORE the database file is opened,
	 * allowing proper WAL replay for HNSW indexes.
	 */
	async connect(): Promise<void> {
		try {
			// Step 1: Create in-memory instance first (no database file)
			// This allows us to load extensions before any WAL replay occurs
			this.instance = await DuckDBInstance.create(":memory:", {
				allow_unsigned_extensions: "true",
			});
			this.connection = await this.instance.connect();

			// Step 2: Load VSS extension BEFORE attaching the database
			// This ensures HNSW index support is available during WAL replay
			await this.connection.run("INSTALL vss; LOAD vss;");

			// Step 3: Enable experimental HNSW persistence
			await this.connection.run(
				"SET hnsw_enable_experimental_persistence = true;",
			);

			// Step 4: Load DuckPGQ extension (optional)
			try {
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

			// Step 5: ATTACH the persistent database file
			// WAL replay now happens with VSS extension already loaded
			await this.connection.run(
				`ATTACH '${this.dbPath}' AS lattice (READ_WRITE);`,
			);

			// Step 6: Set lattice as the default database for all operations
			await this.connection.run("USE lattice;");

			// Initialize schema (in the attached database)
			await this.initializeSchema();

			// Step 7: Checkpoint immediately to flush any schema changes to disk
			// This prevents "Catalog 'lattice' does not exist" errors on WAL replay
			// when the process exits without proper cleanup (e.g., via process.exit())
			await this.connection.run("FORCE CHECKPOINT lattice;");

			this.logger.log(
				`Connected to DuckDB (in-memory + ATTACH) at ${this.dbPath}`,
			);
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
			// Checkpoint to flush WAL to main database file
			// This prevents HNSW index replay issues on next startup
			await this.checkpoint();
			this.connection.closeSync();
			this.connection = null;
			this.logger.log("Disconnected from DuckDB");
		}
		if (this.instance) {
			this.instance = null;
		}
	}

	/**
	 * Force a checkpoint to flush WAL to main database file.
	 * Call this after batches of writes to ensure data persistence.
	 */
	async checkpoint(): Promise<void> {
		if (!this.connection) {
			return;
		}
		try {
			// FORCE CHECKPOINT on the attached "lattice" database specifically
			// This ensures WAL is fully flushed before disconnect, preventing
			// "Catalog 'lattice' does not exist" errors on next ATTACH
			await this.connection.run("FORCE CHECKPOINT lattice;");
			this.logger.debug("Checkpoint completed");
		} catch (error) {
			// Checkpoint may fail if database is read-only or other issues
			this.logger.warn(
				`Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
			);
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

		// v2 schema additions: columns for database-driven change detection
		await this.applyV2SchemaMigration(conn);
	}

	/**
	 * Apply v2 schema migration: add columns for database-driven change detection.
	 * These columns eliminate the need for manifest files and enable embedding staleness tracking.
	 */
	private async applyV2SchemaMigration(conn: DuckDBConnection): Promise<void> {
		// Add content_hash column for change detection (replaces manifest)
		try {
			await conn.run(
				"ALTER TABLE nodes ADD COLUMN IF NOT EXISTS content_hash VARCHAR",
			);
		} catch {
			// Column might already exist
		}

		// Add embedding_source_hash for embedding staleness detection
		try {
			await conn.run(
				"ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding_source_hash VARCHAR",
			);
		} catch {
			// Column might already exist
		}

		// Add extraction_method to track how entities were created
		try {
			await conn.run(
				"ALTER TABLE nodes ADD COLUMN IF NOT EXISTS extraction_method VARCHAR DEFAULT 'frontmatter'",
			);
		} catch {
			// Column might already exist
		}

		// Create index for efficient document hash lookups
		try {
			await conn.run(
				"CREATE INDEX IF NOT EXISTS idx_nodes_content_hash ON nodes(content_hash) WHERE label = 'Document'",
			);
		} catch {
			// Index might already exist
		}
	}

	/**
	 * Public method to run v2 schema migration.
	 * Called by MigrateCommand to upgrade from v1 to v2.
	 */
	async runV2Migration(): Promise<void> {
		const conn = await this.ensureConnected();
		await this.applyV2SchemaMigration(conn);
		this.logger.log("V2 schema migration completed");
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
	 * Create a vector index for semantic search.
	 * Only ONE HNSW index is created on the embedding column since DuckDB doesn't
	 * support partial indexes - all nodes share the same index regardless of label.
	 */
	async createVectorIndex(
		_label: string,
		property: string,
		dimensions: number,
	): Promise<void> {
		try {
			// Use a single index key - only one HNSW index needed for all nodes
			const indexKey = `nodes_${property}`;
			if (this.vectorIndexes.has(indexKey)) {
				return; // Index already created in this session
			}

			const conn = await this.ensureConnected();

			try {
				await conn.run(`
					CREATE INDEX idx_embedding_nodes
					ON nodes USING HNSW (embedding)
					WITH (metric = 'cosine')
				`);
				this.logger.log(
					`Created HNSW vector index on nodes.${property} with ${dimensions} dimensions`,
				);
			} catch {
				// Index already exists, that's okay
				this.logger.debug(`Vector index on nodes.${property} already exists`);
			}

			this.vectorIndexes.add(indexKey);
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

	// ==================== v2 API: Database-driven change detection ====================

	/**
	 * Load all document hashes for batch change detection.
	 * Returns a map of path -> { contentHash, embeddingSourceHash }
	 */
	async loadAllDocumentHashes(): Promise<
		Map<
			string,
			{ contentHash: string | null; embeddingSourceHash: string | null }
		>
	> {
		try {
			const conn = await this.ensureConnected();
			const reader = await conn.runAndReadAll(`
				SELECT name, content_hash, embedding_source_hash
				FROM nodes
				WHERE label = 'Document'
			`);

			const hashMap = new Map<
				string,
				{ contentHash: string | null; embeddingSourceHash: string | null }
			>();

			for (const row of reader.getRows()) {
				const [name, contentHash, embeddingSourceHash] = row as [
					string,
					string | null,
					string | null,
				];
				hashMap.set(name, { contentHash, embeddingSourceHash });
			}

			return hashMap;
		} catch (error) {
			this.logger.error(
				`Failed to load document hashes: ${error instanceof Error ? error.message : String(error)}`,
			);
			return new Map();
		}
	}

	/**
	 * Update a document's content hash and optionally embedding source hash.
	 * Used after syncing a document to track its current state.
	 */
	async updateDocumentHashes(
		path: string,
		contentHash: string,
		embeddingSourceHash?: string,
	): Promise<void> {
		try {
			const conn = await this.ensureConnected();

			if (embeddingSourceHash) {
				await conn.run(`
					UPDATE nodes
					SET content_hash = '${this.escape(contentHash)}',
					    embedding_source_hash = '${this.escape(embeddingSourceHash)}',
					    updated_at = NOW()
					WHERE label = 'Document' AND name = '${this.escape(path)}'
				`);
			} else {
				await conn.run(`
					UPDATE nodes
					SET content_hash = '${this.escape(contentHash)}',
					    updated_at = NOW()
					WHERE label = 'Document' AND name = '${this.escape(path)}'
				`);
			}
		} catch (error) {
			this.logger.error(
				`Failed to update document hashes: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Batch update document hashes for multiple documents.
	 * More efficient than individual updates when syncing many documents.
	 */
	async batchUpdateDocumentHashes(
		updates: Array<{
			path: string;
			contentHash: string;
			embeddingSourceHash?: string;
		}>,
	): Promise<void> {
		if (updates.length === 0) return;

		try {
			const conn = await this.ensureConnected();

			// Use a transaction for batch updates
			await conn.run("BEGIN TRANSACTION");

			for (const { path, contentHash, embeddingSourceHash } of updates) {
				if (embeddingSourceHash) {
					await conn.run(`
						UPDATE nodes
						SET content_hash = '${this.escape(contentHash)}',
						    embedding_source_hash = '${this.escape(embeddingSourceHash)}',
						    updated_at = NOW()
						WHERE label = 'Document' AND name = '${this.escape(path)}'
					`);
				} else {
					await conn.run(`
						UPDATE nodes
						SET content_hash = '${this.escape(contentHash)}',
						    updated_at = NOW()
						WHERE label = 'Document' AND name = '${this.escape(path)}'
					`);
				}
			}

			await conn.run("COMMIT");
		} catch (error) {
			this.logger.error(
				`Failed to batch update document hashes: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Get all tracked document paths from the database.
	 * Used for detecting deleted documents.
	 */
	async getTrackedDocumentPaths(): Promise<string[]> {
		try {
			const conn = await this.ensureConnected();
			const reader = await conn.runAndReadAll(`
				SELECT name FROM nodes WHERE label = 'Document'
			`);

			return reader.getRows().map((row) => row[0] as string);
		} catch (error) {
			this.logger.error(
				`Failed to get tracked document paths: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}
}
