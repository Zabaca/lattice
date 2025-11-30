import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { EmbeddingService } from "../embedding/embedding.service.js";
import { GraphService } from "../graph/graph.service.js";

// Search Command
interface SearchCommandOptions {
	label?: string;
	limit?: string;
}

@Injectable()
@Command({
	name: "search",
	arguments: "<query>",
	description: "Semantic search across the knowledge graph",
})
export class SearchCommand extends CommandRunner {
	constructor(
		private readonly graphService: GraphService,
		private readonly embeddingService: EmbeddingService,
	) {
		super();
	}

	async run(inputs: string[], options: SearchCommandOptions): Promise<void> {
		const query = inputs[0];
		const limit = Math.min(parseInt(options.limit || "20", 10), 100);

		try {
			// Generate embedding for the query
			const queryEmbedding =
				await this.embeddingService.generateEmbedding(query);

			let results: Array<{
				name: string;
				label: string;
				title?: string;
				description?: string;
				score: number;
			}>;

			if (options.label) {
				// Search within specific label
				const labelResults = await this.graphService.vectorSearch(
					options.label,
					queryEmbedding,
					limit,
				);
				results = labelResults.map((r) => ({
					name: r.name,
					label: options.label as string,
					title: r.title,
					score: r.score,
				}));
			} else {
				// Search across all entity types
				results = await this.graphService.vectorSearchAll(
					queryEmbedding,
					limit,
				);
			}

			const labelSuffix = options.label ? ` (${options.label})` : "";
			console.log(
				`\n=== Semantic Search Results for "${query}"${labelSuffix} ===\n`,
			);

			if (results.length === 0) {
				console.log("No results found.\n");
				if (options.label) {
					console.log("Tip: Try without --label to search all entity types.\n");
				}
				process.exit(0);
			}

			results.forEach((result, idx) => {
				console.log(`${idx + 1}. [${result.label}] ${result.name}`);
				if (result.title) {
					console.log(`   Title: ${result.title}`);
				}
				if (result.description && result.label !== "Document") {
					const desc =
						result.description.length > 80
							? `${result.description.slice(0, 80)}...`
							: result.description;
					console.log(`   ${desc}`);
				}
				console.log(`   Similarity: ${(result.score * 100).toFixed(2)}%`);
			});
			console.log();

			process.exit(0);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error("Error:", errorMsg);

			if (errorMsg.includes("no embeddings") || errorMsg.includes("vector")) {
				console.log(
					"\nNote: Semantic search requires embeddings to be generated first.",
				);
				console.log(
					"Run 'lattice sync' to generate embeddings for documents.\n",
				);
			}

			process.exit(1);
		}
	}

	@Option({
		flags: "-l, --label <label>",
		description: "Filter by entity label (e.g., Technology, Concept, Document)",
	})
	parseLabel(value: string): string {
		return value;
	}

	@Option({
		flags: "--limit <n>",
		description: "Limit results",
		defaultValue: "20",
	})
	parseLimit(value: string): string {
		return value;
	}
}

// Rels Command
@Injectable()
@Command({
	name: "rels",
	arguments: "<name>",
	description: "Show relationships for a node",
})
export class RelsCommand extends CommandRunner {
	constructor(private readonly graphService: GraphService) {
		super();
	}

	async run(inputs: string[]): Promise<void> {
		const name = inputs[0];

		try {
			const escapedName = name.replace(/'/g, "\\'");
			const cypher = `MATCH (a { name: '${escapedName}' })-[r]-(b) RETURN a, r, b`;

			const result = await this.graphService.query(cypher);
			const results = result.resultSet || [];

			console.log(`\n=== Relationships for "${name}" ===\n`);

			if (results.length === 0) {
				console.log("No relationships found.\n");
				process.exit(0);
			}

			const incoming: string[] = [];
			const outgoing: string[] = [];

			for (const row of results as unknown[][]) {
				const [source, rel, target] = row as [
					[string, unknown][],
					[string, unknown][],
					[string, unknown][],
				];
				// FalkorDB returns arrays of tuples, convert to objects
				const sourceObj = Object.fromEntries(source) as Record<string, unknown>;
				const targetObj = Object.fromEntries(target) as Record<string, unknown>;
				const relObj = Object.fromEntries(rel) as Record<string, unknown>;

				const sourceProps = Object.fromEntries(
					(sourceObj.properties as [string, unknown][]) || [],
				) as Record<string, unknown>;
				const targetProps = Object.fromEntries(
					(targetObj.properties as [string, unknown][]) || [],
				) as Record<string, unknown>;

				const sourceName = (sourceProps.name as string) || "unknown";
				const targetName = (targetProps.name as string) || "unknown";
				const relType = (relObj.type as string) || "UNKNOWN";

				if (sourceName === name) {
					outgoing.push(`  -[${relType}]-> ${targetName}`);
				} else {
					incoming.push(`  <-[${relType}]- ${sourceName}`);
				}
			}

			if (outgoing.length > 0) {
				console.log("Outgoing:");
				for (const r of outgoing) {
					console.log(r);
				}
			}

			if (incoming.length > 0) {
				if (outgoing.length > 0) console.log();
				console.log("Incoming:");
				for (const r of incoming) {
					console.log(r);
				}
			}
			console.log();

			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}
}

// Cypher Command
@Injectable()
@Command({
	name: "cypher",
	arguments: "<query>",
	description: "Execute raw Cypher query",
})
export class CypherCommand extends CommandRunner {
	constructor(private readonly graphService: GraphService) {
		super();
	}

	async run(inputs: string[]): Promise<void> {
		const query = inputs[0];

		try {
			const result = await this.graphService.query(query);

			console.log("\n=== Cypher Query Results ===\n");
			console.log(JSON.stringify(result, null, 2));
			console.log();

			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}
}
