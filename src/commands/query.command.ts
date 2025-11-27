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
					logger: false,
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

	// Search command - search for nodes
	program
		.command("search")
		.description("Search for nodes in the graph or perform semantic search")
		.option("-l, --label <label>", "Filter by node label")
		.option("-n, --name <name>", "Filter by name (substring match)")
		.option("-s, --semantic <query>", "Perform semantic/vector search on documents")
		.option("--limit <n>", "Limit results", "20")
		.action(async (options) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: false,
				});
				const graph = app.get(GraphService);

				// Handle semantic search
				if (options.semantic) {
					const embedding = app.get(EmbeddingService);
					const limit = Math.min(parseInt(options.limit, 10), 100);

					try {
						// Generate embedding for the query
						const queryEmbedding = await embedding.generateEmbedding(
							options.semantic
						);

						// Perform vector search across all entity types
						const results = await graph.vectorSearchAll(
							queryEmbedding,
							limit
						);

						console.log(`\n=== Semantic Search Results for "${options.semantic}" ===\n`);

						if (results.length === 0) {
							console.log("No results found with semantic search.\n");
							await app.close();
							process.exit(0);
						}

						results.forEach((result, idx) => {
							console.log(`${idx + 1}. [${result.label}] ${result.name}`);
							if (result.title) {
								console.log(`   Title: ${result.title}`);
							}
							if (result.description && result.label !== 'Document') {
								// Truncate long descriptions
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
					} catch (semanticError) {
						const errorMsg =
							semanticError instanceof Error
								? semanticError.message
								: String(semanticError);
						console.error(
							"Semantic search error:",
							errorMsg
						);
						if (
							errorMsg.includes("no embeddings") ||
							errorMsg.includes("vector")
						) {
							console.log(
								"\nNote: Semantic search requires embeddings to be generated first."
							);
							console.log(
								"Run 'lattice sync' to generate embeddings for documents.\n"
							);
						}
						await app.close();
						process.exit(1);
					}
				}

				// Handle traditional keyword search
				let cypher: string;
				const limit = Math.min(parseInt(options.limit, 10), 100);

				if (options.label && options.name) {
					const escapedLabel = options.label.replace(/`/g, "\\`");
					const escapedName = options.name.replace(/'/g, "\\'");
					cypher = `MATCH (n:\`${escapedLabel}\`) WHERE n.name CONTAINS '${escapedName}' RETURN n LIMIT ${limit}`;
				} else if (options.label) {
					const escapedLabel = options.label.replace(/`/g, "\\`");
					cypher = `MATCH (n:\`${escapedLabel}\`) RETURN n LIMIT ${limit}`;
				} else if (options.name) {
					const escapedName = options.name.replace(/'/g, "\\'");
					cypher = `MATCH (n) WHERE n.name CONTAINS '${escapedName}' RETURN n LIMIT ${limit}`;
				} else {
					cypher = `MATCH (n) RETURN n LIMIT ${limit}`;
				}

				const result = await graph.query(cypher);
				const results = result.resultSet || [];

				console.log(`\n=== Search Results (${results.length} nodes) ===\n`);

				if (results.length === 0) {
					console.log("No nodes found matching criteria.\n");
					await app.close();
					process.exit(0);
				}

				results.forEach((row: any) => {
					const node = row[0];
					const labels = (node.labels || []).join(", ");
					const name = node.properties?.name || "unnamed";

					console.log(`[${labels}] ${name}`);
					if (node.properties?.description) {
						console.log(`  Description: ${node.properties.description}`);
					}
					if (node.properties?.importance) {
						console.log(`  Importance: ${node.properties.importance}`);
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

	// Rels command - show relationships for a node
	program
		.command("rels <name>")
		.description("Show relationships for a node")
		.action(async (name: string) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: false,
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
					logger: false,
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
					logger: false,
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
