#!/usr/bin/env bun
/**
 * Migration script to export data from FalkorDB and import into DuckDB.
 * This preserves embeddings to avoid costly API calls for regeneration.
 *
 * Usage:
 *   FALKORDB_HOST=localhost FALKORDB_PORT=30637 bun scripts/migrate-falkordb.ts
 *
 * Or with defaults:
 *   bun scripts/migrate-falkordb.ts --host localhost --port 30637
 */

import { Redis } from "ioredis";
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFileSync } from "node:fs";

interface FalkorNode {
	id: number;
	labels: string[];
	properties: Record<string, unknown>;
}

interface FalkorRelationship {
	id: number;
	type: string;
	sourceId: number;
	destId: number;
	properties: Record<string, unknown>;
}

interface ExportData {
	nodes: FalkorNode[];
	relationships: FalkorRelationship[];
	exportedAt: string;
}

const GRAPH_NAME = process.env.GRAPH_NAME || "research_knowledge";

async function main() {
	const host = process.env.FALKORDB_HOST || "localhost";
	const port = parseInt(process.env.FALKORDB_PORT || "6379", 10);
	const outputFile = process.argv[2] || "./falkordb-export.json";
	const duckdbPath =
		process.env.DUCKDB_PATH || "/home/uptown/Projects/research/docs/.lattice.duckdb";

	console.log(`Connecting to FalkorDB at ${host}:${port}...`);
	console.log(`Graph: ${GRAPH_NAME}`);

	const redis = new Redis({
		host,
		port,
		lazyConnect: true,
	});

	try {
		await redis.connect();
		console.log("Connected to FalkorDB");

		// Export nodes
		console.log("Exporting nodes...");
		const nodesResult = await redis.call(
			"GRAPH.QUERY",
			GRAPH_NAME,
			"MATCH (n) RETURN n",
		);
		const nodes = parseNodes(nodesResult as unknown[]);
		console.log(`  Found ${nodes.length} nodes`);

		// Export relationships
		console.log("Exporting relationships...");
		const relsResult = await redis.call(
			"GRAPH.QUERY",
			GRAPH_NAME,
			"MATCH (a)-[r]->(b) RETURN ID(a), ID(b), type(r), properties(r)",
		);
		const relationships = parseRelationships(relsResult as unknown[], nodes);
		console.log(`  Found ${relationships.length} relationships`);

		// Count embeddings
		const nodesWithEmbeddings = nodes.filter(
			(n) => n.properties.embedding && Array.isArray(n.properties.embedding),
		);
		console.log(`  Nodes with embeddings: ${nodesWithEmbeddings.length}`);

		// Save export to file
		const exportData: ExportData = {
			nodes,
			relationships,
			exportedAt: new Date().toISOString(),
		};

		writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
		console.log(`\nExported data to ${outputFile}`);

		// Import into DuckDB
		console.log(`\nImporting into DuckDB at ${duckdbPath}...`);
		await importToDuckDB(exportData, duckdbPath);

		console.log("\nMigration complete!");
	} catch (error) {
		console.error(
			"Migration failed:",
			error instanceof Error ? error.message : String(error),
		);
		process.exit(1);
	} finally {
		await redis.quit();
	}
}

/**
 * Parse FalkorDB embedding string format: <-0.025690, 0.046957, ...>
 */
function parseEmbedding(embeddingStr: string): number[] | null {
	if (typeof embeddingStr !== "string" || !embeddingStr.startsWith("<")) {
		return null;
	}

	try {
		// Remove < and > and split by comma
		const content = embeddingStr.slice(1, -1);
		const values = content.split(",").map((v) => parseFloat(v.trim()));
		return values;
	} catch {
		return null;
	}
}

/**
 * Parse FalkorDB node results into structured data
 * FalkorDB format: [header, rows, stats]
 * Each row contains a node: [[[key, value], [key, value], ...]]
 * Node format: [[id, N], [labels, [...]], [properties, [[k,v], [k,v]]]]
 */
function parseNodes(result: unknown[]): FalkorNode[] {
	const nodes: FalkorNode[] = [];

	if (!Array.isArray(result) || result.length < 2) {
		return nodes;
	}

	// FalkorDB result format: [header, rows, stats]
	const rows = result[1] as unknown[][];

	for (const row of rows) {
		if (!Array.isArray(row) || row.length === 0) continue;

		// Each row is [[nodeData]]
		const nodeData = row[0] as Array<[string, unknown]>;
		if (!Array.isArray(nodeData)) continue;

		let id = 0;
		let labels: string[] = [];
		const properties: Record<string, unknown> = {};

		for (const [key, value] of nodeData) {
			if (key === "id") {
				id = value as number;
			} else if (key === "labels") {
				labels = value as string[];
			} else if (key === "properties") {
				// Properties is an array of [key, value] pairs
				const propsArray = value as Array<[string, unknown]>;
				for (const [propKey, propValue] of propsArray) {
					// Parse embedding if it's in string format
					if (propKey === "embedding" && typeof propValue === "string") {
						properties[propKey] = parseEmbedding(propValue);
					} else {
						properties[propKey] = propValue;
					}
				}
			}
		}

		nodes.push({
			id,
			labels,
			properties,
		});
	}

	return nodes;
}

/**
 * Parse FalkorDB relationship results into structured data
 * Query: MATCH (a)-[r]->(b) RETURN ID(a), ID(b), type(r), properties(r)
 */
function parseRelationships(result: unknown[], nodes: FalkorNode[]): FalkorRelationship[] {
	const relationships: FalkorRelationship[] = [];

	if (!Array.isArray(result) || result.length < 2) {
		return relationships;
	}

	// FalkorDB result format: [header, rows, stats]
	const rows = result[1] as unknown[][];

	let id = 0;
	for (const row of rows) {
		if (!Array.isArray(row) || row.length < 4) continue;

		const [sourceId, destId, type, propsArray] = row as [
			number,
			number,
			string,
			Array<[string, unknown]> | null,
		];

		const properties: Record<string, unknown> = {};
		if (Array.isArray(propsArray)) {
			for (const [propKey, propValue] of propsArray) {
				properties[propKey] = propValue;
			}
		}

		relationships.push({
			id: id++,
			type,
			sourceId,
			destId,
			properties,
		});
	}

	return relationships;
}

/**
 * Import exported data into DuckDB
 */
async function importToDuckDB(
	data: ExportData,
	duckdbPath: string,
): Promise<void> {
	const embeddingDimensions = 512;

	// Create a fresh DuckDB instance
	const instance = await DuckDBInstance.create(duckdbPath, {
		allow_unsigned_extensions: "true",
	});
	const conn = await instance.connect();

	try {
		// Load VSS extension
		await conn.run("INSTALL vss; LOAD vss;");
		await conn.run("SET hnsw_enable_experimental_persistence = true;");

		// Create schema if not exists
		await conn.run(`
			CREATE TABLE IF NOT EXISTS nodes (
				label VARCHAR NOT NULL,
				name VARCHAR NOT NULL,
				properties JSON,
				embedding FLOAT[${embeddingDimensions}],
				created_at TIMESTAMP DEFAULT NOW(),
				updated_at TIMESTAMP DEFAULT NOW(),
				PRIMARY KEY(label, name)
			)
		`);

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

		// Build node lookup by ID
		const nodeById = new Map<number, FalkorNode>();
		for (const node of data.nodes) {
			nodeById.set(node.id, node);
		}

		// Import nodes
		console.log("  Importing nodes...");
		let nodesImported = 0;
		let embeddingsImported = 0;

		for (const node of data.nodes) {
			const label = node.labels[0] || "Unknown";
			const name = node.properties.name as string;

			if (!name) {
				console.warn(`  Skipping node without name: id=${node.id}, labels=${node.labels.join(",")}`);
				continue;
			}

			// Extract embedding from properties
			const { embedding, ...otherProps } = node.properties;
			const propsJson = JSON.stringify(otherProps);

			// Escape single quotes
			const escapedLabel = label.replace(/'/g, "''");
			const escapedName = String(name).replace(/'/g, "''");
			const escapedProps = propsJson.replace(/'/g, "''");

			if (embedding && Array.isArray(embedding) && embedding.length === embeddingDimensions) {
				// Insert with embedding
				const vectorStr = `[${(embedding as number[]).join(", ")}]`;
				await conn.run(`
					INSERT INTO nodes (label, name, properties, embedding)
					VALUES ('${escapedLabel}', '${escapedName}', '${escapedProps}', ${vectorStr}::FLOAT[${embeddingDimensions}])
					ON CONFLICT (label, name) DO UPDATE SET
						properties = EXCLUDED.properties,
						embedding = EXCLUDED.embedding,
						updated_at = NOW()
				`);
				embeddingsImported++;
			} else {
				// Insert without embedding
				await conn.run(`
					INSERT INTO nodes (label, name, properties)
					VALUES ('${escapedLabel}', '${escapedName}', '${escapedProps}')
					ON CONFLICT (label, name) DO UPDATE SET
						properties = EXCLUDED.properties,
						updated_at = NOW()
				`);
			}
			nodesImported++;
		}

		console.log(`  Imported ${nodesImported} nodes (${embeddingsImported} with embeddings)`);

		// Import relationships
		console.log("  Importing relationships...");
		let relsImported = 0;

		for (const rel of data.relationships) {
			const sourceNode = nodeById.get(rel.sourceId);
			const targetNode = nodeById.get(rel.destId);

			if (!sourceNode || !targetNode) {
				continue;
			}

			const sourceLabel = sourceNode.labels[0] || "Unknown";
			const sourceName = sourceNode.properties.name as string;
			const targetLabel = targetNode.labels[0] || "Unknown";
			const targetName = targetNode.properties.name as string;

			if (!sourceName || !targetName) {
				continue;
			}

			const propsJson = JSON.stringify(rel.properties);

			// Escape single quotes
			const escape = (s: string) => s.replace(/'/g, "''");

			try {
				await conn.run(`
					INSERT INTO relationships (source_label, source_name, relation_type, target_label, target_name, properties)
					VALUES (
						'${escape(sourceLabel)}',
						'${escape(String(sourceName))}',
						'${escape(rel.type)}',
						'${escape(targetLabel)}',
						'${escape(String(targetName))}',
						'${escape(propsJson)}'
					)
					ON CONFLICT (source_label, source_name, relation_type, target_label, target_name) DO UPDATE SET
						properties = EXCLUDED.properties
				`);
				relsImported++;
			} catch (e) {
				console.warn(`  Failed to import relationship: ${rel.type} (${sourceName} -> ${targetName}): ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		console.log(`  Imported ${relsImported} relationships`);

		// Create vector index
		console.log("  Creating vector index...");
		try {
			await conn.run(`
				CREATE INDEX IF NOT EXISTS idx_embedding_nodes
				ON nodes USING HNSW (embedding)
				WITH (metric = 'cosine')
			`);
		} catch {
			console.log("  Vector index already exists or failed to create");
		}
	} finally {
		conn.closeSync();
	}
}

main();
