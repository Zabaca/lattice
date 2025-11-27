import { Command } from "commander";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { GraphService } from "../graph/graph.service.js";
import { EmbeddingService } from "../embedding/embedding.service.js";
import { PathResolverService } from "../sync/path-resolver.service.js";
import type { GraphStats } from "../graph/graph.types.js";

export function registerQueryCommands(program: Command) {
	// Stats command - show graph statistics
	program
		.command("stats")
		.description("Show graph statistics")
		.action(async () => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: ['error'],
				});
				const graph = app.get(GraphService);

				const stats: GraphStats = await graph.getStats();
				console.log("\n=== Graph Statistics ===\n");
				console.log(`Total Nodes: ${stats.nodeCount}`);
				console.log(`Total Relationships: ${stats.edgeCount}\n`);

				console.log(`Node Labels (${stats.labels.length}):`);
				stats.labels.forEach((label) => {
					const count = stats.entityCounts[label] || 0;
					console.log(`  - ${label}: ${count}`);
				});

				console.log(
					`\nRelationship Types (${stats.relationshipTypes.length}):`
				);
				stats.relationshipTypes.forEach((relType) => {
					const count = stats.relationshipCounts[relType] || 0;
					console.log(`  - ${relType}: ${count}`);
				});
				console.log();

				await app.close();
				process.exit(0);
			} catch (error) {
				console.error(
					"Error:",
					error instanceof Error ? error.message : String(error)
				);
				if (app) await app.close();
				process.exit(1);
			}
		});

	// Search command - semantic search across the knowledge graph
	program
		.command("search <query>")
		.description("Semantic search across the knowledge graph")
		.option("-l, --label <label>", "Filter by entity label (e.g., Technology, Concept, Document)")
		.option("--limit <n>", "Limit results", "20")
		.action(async (query: string, options) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: ['error'],
				});
				const graph = app.get(GraphService);
				const embedding = app.get(EmbeddingService);
				const limit = Math.min(parseInt(options.limit, 10), 100);

				// Generate embedding for the query
				const queryEmbedding = await embedding.generateEmbedding(query);

				let results: Array<{ name: string; label: string; title?: string; description?: string; score: number }>;

				if (options.label) {
					// Search within specific label
					const labelResults = await graph.vectorSearch(options.label, queryEmbedding, limit);
					results = labelResults.map(r => ({
						name: r.name,
						label: options.label,
						title: r.title,
						score: r.score,
					}));
				} else {
					// Search across all entity types
					results = await graph.vectorSearchAll(queryEmbedding, limit);
				}

				const labelSuffix = options.label ? ` (${options.label})` : '';
				console.log(`\n=== Semantic Search Results for "${query}"${labelSuffix} ===\n`);

				if (results.length === 0) {
					console.log("No results found.\n");
					if (options.label) {
						console.log(`Tip: Try without --label to search all entity types.\n`);
					}
					await app.close();
					process.exit(0);
				}

				results.forEach((result, idx) => {
					console.log(`${idx + 1}. [${result.label}] ${result.name}`);
					if (result.title) {
						console.log(`   Title: ${result.title}`);
					}
					if (result.description && result.label !== 'Document') {
						const desc = result.description.length > 80
							? result.description.slice(0, 80) + '...'
							: result.description;
						console.log(`   ${desc}`);
					}
					console.log(`   Similarity: ${(result.score * 100).toFixed(2)}%`);
				});
				console.log();

				await app.close();
				process.exit(0);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				console.error("Error:", errorMsg);

				if (errorMsg.includes("no embeddings") || errorMsg.includes("vector")) {
					console.log("\nNote: Semantic search requires embeddings to be generated first.");
					console.log("Run 'lattice sync' to generate embeddings for documents.\n");
				}

				if (app) await app.close();
				process.exit(1);
			}
		});

	// Rels command - show relationships for a node
	program
		.command("rels <name>")
		.description("Show relationships for a node")
		.action(async (name: string) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: ['error'],
				});
				const graph = app.get(GraphService);

				const escapedName = name.replace(/'/g, "\\'");
				const cypher = `MATCH (a { name: '${escapedName}' })-[r]-(b) RETURN a, r, b`;

				const result = await graph.query(cypher);
				const results = result.resultSet || [];

				console.log(`\n=== Relationships for "${name}" ===\n`);

				if (results.length === 0) {
					console.log("No relationships found.\n");
					await app.close();
					process.exit(0);
				}

				const incoming: string[] = [];
				const outgoing: string[] = [];

				results.forEach((row: any) => {
					const [source, rel, target] = row;
					const sourceName = source.properties?.name || "unknown";
					const targetName = target.properties?.name || "unknown";
					const relType = rel.type || "UNKNOWN";

					if (sourceName === name) {
						outgoing.push(`  -[${relType}]-> ${targetName}`);
					} else {
						incoming.push(`  <-[${relType}]- ${sourceName}`);
					}
				});

				if (outgoing.length > 0) {
					console.log("Outgoing:");
					outgoing.forEach((r) => console.log(r));
				}

				if (incoming.length > 0) {
					if (outgoing.length > 0) console.log();
					console.log("Incoming:");
					incoming.forEach((r) => console.log(r));
				}
				console.log();

				await app.close();
				process.exit(0);
			} catch (error) {
				console.error(
					"Error:",
					error instanceof Error ? error.message : String(error)
				);
				if (app) await app.close();
				process.exit(1);
			}
		});

	// Cypher command - run raw cypher query
	program
		.command("cypher <query>")
		.description("Execute raw Cypher query")
		.action(async (query: string) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: ['error'],
				});
				const graph = app.get(GraphService);

				const result = await graph.query(query);

				console.log("\n=== Cypher Query Results ===\n");
				console.log(JSON.stringify(result, null, 2));
				console.log();

				await app.close();
				process.exit(0);
			} catch (error) {
				console.error(
					"Error:",
					error instanceof Error ? error.message : String(error)
				);
				if (app) await app.close();
				process.exit(1);
			}
		});

	// Related command - find related documents
	program
		.command("related <path>")
		.description("Find documents related to the given document")
		.option("--limit <n>", "Limit results", "10")
		.action(async (path: string, options) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: ['error'],
				});
				const graph = app.get(GraphService);
				const pathResolver = app.get(PathResolverService);

				// Resolve user-provided path to absolute form
				const absolutePath = pathResolver.resolveDocPath(path, {
					requireExists: true,
					requireInDocs: true,
				});

				const limit = Math.min(parseInt(options.limit, 10), 50);
				const escapedPath = absolutePath.replace(/'/g, "\\'");

				// Find entities in the document, then find other documents with same entities
				const cypher = `
					MATCH (d:Document { name: '${escapedPath}' })<-[:APPEARS_IN]-(e)-[:APPEARS_IN]->(other:Document)
					WHERE other.name <> '${escapedPath}'
					RETURN DISTINCT other.name as path, other.title as title, count(e) as shared
					ORDER BY shared DESC
					LIMIT ${limit}
				`;

				const result = await graph.query(cypher);
				const results = result.resultSet || [];

				console.log(`\n=== Documents Related to "${path}" ===\n`);

				if (results.length === 0) {
					console.log("No related documents found.\n");
					await app.close();
					process.exit(0);
				}

				results.forEach((row: any) => {
					const docPath = row[0];
					const title = row[1];
					const shared = row[2];

					console.log(`[${shared} shared entities] ${docPath}`);
					if (title) {
						console.log(`  Title: ${title}`);
					}
				});
				console.log();

				await app.close();
				process.exit(0);
			} catch (error) {
				console.error(
					"Error:",
					error instanceof Error ? error.message : String(error)
				);
				if (app) await app.close();
				process.exit(1);
			}
		});
}
