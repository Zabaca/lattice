import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { ExaSearchService } from "../research/exa-search.service.js";

interface ResearchCommandOptions {
	numResults?: string;
	type?: string;
	category?: string;
	includeDomains?: string;
	excludeDomains?: string;
	startDate?: string;
	json?: boolean;
}

@Injectable()
@Command({
	name: "research",
	arguments: "<query>",
	description: "Search the web via Exa API (requires EXA_API_KEY)",
})
export class ResearchCommand extends CommandRunner {
	constructor(private readonly exaSearchService: ExaSearchService) {
		super();
	}

	async run(inputs: string[], options: ResearchCommandOptions): Promise<void> {
		const query = inputs[0];

		if (!this.exaSearchService.isConfigured()) {
			console.log("\nExa API is not configured.\n");
			console.log(
				"To enable web research, add your API key to ~/.lattice/.env:",
			);
			console.log("  EXA_API_KEY=your-key-here\n");
			console.log("Get an API key at: https://exa.ai\n");
			process.exit(1);
		}

		try {
			const response = await this.exaSearchService.search({
				query,
				numResults: options.numResults
					? Number.parseInt(options.numResults, 10)
					: 10,
				type: (options.type as "auto" | "keyword" | "neural") ?? "auto",
				category: options.category,
				includeDomains: options.includeDomains
					? options.includeDomains.split(",")
					: undefined,
				excludeDomains: options.excludeDomains
					? options.excludeDomains.split(",")
					: undefined,
				startPublishedDate: options.startDate
					? `${options.startDate}T00:00:00.000Z`
					: undefined,
				contents: { highlights: true, summary: true },
			});

			if (options.json) {
				console.log(JSON.stringify(response, null, 2));
				process.exit(0);
			}

			console.log(`\n=== Exa Research Results for "${query}" ===\n`);

			if (response.results.length === 0) {
				console.log("No results found.\n");
				process.exit(0);
			}

			for (const [idx, result] of response.results.entries()) {
				console.log(`${idx + 1}. ${result.title}`);
				console.log(`   ${result.url}`);
				if (result.publishedDate) {
					console.log(`   Published: ${result.publishedDate.split("T")[0]}`);
				}
				if (result.summary) {
					const summary =
						result.summary.length > 200
							? `${result.summary.slice(0, 200)}...`
							: result.summary;
					console.log(`   ${summary}`);
				} else if (result.highlights?.length) {
					const highlight = result.highlights[0];
					const text =
						highlight.length > 200
							? `${highlight.slice(0, 200)}...`
							: highlight;
					console.log(`   ${text}`);
				}
				console.log();
			}

			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	@Option({
		flags: "-n, --num-results <n>",
		description: "Number of results (default: 10)",
		defaultValue: "10",
	})
	parseNumResults(value: string): string {
		return value;
	}

	@Option({
		flags: "-t, --type <type>",
		description: "Search type: auto, keyword, neural (default: auto)",
		defaultValue: "auto",
	})
	parseType(value: string): string {
		return value;
	}

	@Option({
		flags: "--category <category>",
		description: "Filter by category (e.g., news, research, article)",
	})
	parseCategory(value: string): string {
		return value;
	}

	@Option({
		flags: "--include-domains <domains>",
		description: "Comma-separated list of domains to include",
	})
	parseIncludeDomains(value: string): string {
		return value;
	}

	@Option({
		flags: "--exclude-domains <domains>",
		description: "Comma-separated list of domains to exclude",
	})
	parseExcludeDomains(value: string): string {
		return value;
	}

	@Option({
		flags: "--start-date <date>",
		description: "Filter results after this date (YYYY-MM-DD)",
	})
	parseStartDate(value: string): string {
		return value;
	}

	@Option({
		flags: "--json",
		description: "Output raw JSON response",
	})
	parseJson(): boolean {
		return true;
	}
}
