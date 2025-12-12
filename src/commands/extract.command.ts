import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable } from "@nestjs/common";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Command, CommandRunner, Option } from "nest-commander";
import { EntityExtractorService } from "../sync/entity-extractor.service.js";

interface ExtractCommandOptions {
	pretty?: boolean;
	raw?: boolean;
}

/**
 * Extract entities from a document using AI.
 * Outputs JSON for debugging/inspection.
 */
@Injectable()
@Command({
	name: "extract",
	description: "Extract entities from a document (debug tool)",
	arguments: "<file>",
})
export class ExtractCommand extends CommandRunner {
	constructor(private readonly entityExtractor: EntityExtractorService) {
		super();
	}

	async run(inputs: string[], options: ExtractCommandOptions): Promise<void> {
		const [filePath] = inputs;

		if (!filePath) {
			console.error("Error: File path is required");
			console.error("Usage: lattice extract <file>");
			process.exit(1);
		}

		// Resolve to absolute path
		const absolutePath = resolve(process.cwd(), filePath);

		if (!existsSync(absolutePath)) {
			console.error(`Error: File not found: ${absolutePath}`);
			process.exit(1);
		}

		try {
			console.error(`Extracting entities from: ${absolutePath}\n`);

			if (options.raw) {
				// Raw mode: show Claude's unprocessed response
				await this.extractRaw(absolutePath);
			} else {
				// Normal mode: show parsed result
				const result =
					await this.entityExtractor.extractFromDocument(absolutePath);

				const output = options.pretty
					? JSON.stringify(result, null, 2)
					: JSON.stringify(result);

				console.log(output);
				process.exit(result.success ? 0 : 1);
			}
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	/**
	 * Extract and show raw Claude response (for debugging).
	 */
	private async extractRaw(filePath: string): Promise<void> {
		const content = readFileSync(filePath, "utf-8");
		const prompt = this.entityExtractor.buildExtractionPrompt(filePath, content);

		console.error("--- Prompt ---");
		console.error(prompt.substring(0, 500) + "...\n");
		console.error("--- Raw Response ---");

		let rawResponse = "";
		for await (const message of query({
			prompt,
			options: {
				maxTurns: 5,
				model: "claude-3-5-haiku-20241022",
				allowedTools: [],
				permissionMode: "default",
			},
		})) {
			if (message.type === "assistant" && message.message?.content) {
				for (const block of message.message.content) {
					if ("text" in block) {
						rawResponse += block.text;
					}
				}
			}
		}

		console.log(rawResponse);
		process.exit(0);
	}

	@Option({
		flags: "-p, --pretty",
		description: "Pretty-print JSON output",
	})
	parsePretty(): boolean {
		return true;
	}

	@Option({
		flags: "-r, --raw",
		description: "Show raw Claude response (for debugging parse errors)",
	})
	parseRaw(): boolean {
		return true;
	}
}
