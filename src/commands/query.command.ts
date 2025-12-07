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
			const relationships = await this.graphService.findRelationships(name);

			console.log(`\n=== Relationships for "${name}" ===\n`);

			if (relationships.length === 0) {
				console.log("No relationships found.\n");
				process.exit(0);
			}

			console.log("Relationships:");
			for (const rel of relationships) {
				const [relType, targetName] = rel as [string, string];
				console.log(`  -[${relType}]-> ${targetName}`);
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

// SQL Command
@Injectable()
@Command({
	name: "sql",
	arguments: "<query>",
	description: "Execute raw SQL query against DuckDB",
})
export class SqlCommand extends CommandRunner {
	constructor(private readonly graphService: GraphService) {
		super();
	}

	async run(inputs: string[]): Promise<void> {
		const query = inputs[0];

		try {
			const result = await this.graphService.query(query);

			console.log("\n=== SQL Query Results ===\n");
			// Handle BigInt serialization
			const replacer = (_key: string, value: unknown) =>
				typeof value === "bigint" ? Number(value) : value;
			console.log(JSON.stringify(result, replacer, 2));
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
