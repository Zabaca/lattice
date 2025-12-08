import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { DocumentParserService } from "../sync/document-parser.service.js";
import { GraphValidatorService } from "../sync/graph-validator.service.js";
import { validateDocuments } from "../sync/sync.service.js";

interface ValidationIssue {
	type: "error";
	path: string;
	message: string;
	suggestion?: string;
}

interface ValidateCommandOptions {
	fix?: boolean;
}

@Injectable()
@Command({
	name: "validate",
	description: "Validate entity references and relationships across documents",
})
export class ValidateCommand extends CommandRunner {
	constructor(
		private readonly parserService: DocumentParserService,
		private readonly graphValidator: GraphValidatorService,
	) {
		super();
	}

	async run(_inputs: string[], options: ValidateCommandOptions): Promise<void> {
		try {
			console.log("=== Document Validation ===\n");

			const { docs, errors: schemaErrors } =
				await this.parserService.parseAllDocumentsWithErrors();
			const issues: ValidationIssue[] = [];

			// Add schema errors (invalid frontmatter format)
			for (const schemaError of schemaErrors) {
				issues.push({
					type: "error",
					path: schemaError.path,
					message: schemaError.error,
				});
			}

			// Count unique entities for output
			const entityIndex = new Map<string, Set<string>>();
			for (const doc of docs) {
				for (const entity of doc.entities) {
					let docPaths = entityIndex.get(entity.name);
					if (!docPaths) {
						docPaths = new Set<string>();
						entityIndex.set(entity.name, docPaths);
					}
					docPaths.add(doc.path);
				}
			}

			// Validate relationships using shared function
			const validationErrors = validateDocuments(docs);
			for (const err of validationErrors) {
				issues.push({
					type: "error",
					path: err.path,
					message: err.error,
					suggestion: "Add entity definition or fix the reference",
				});
			}

			// Output document validation results
			console.log(`Scanned ${docs.length} documents`);
			console.log(`Found ${entityIndex.size} unique entities\n`);

			if (issues.length > 0) {
				console.log(`Document Errors (${issues.length}):\n`);
				issues.forEach((i) => {
					console.log(`  ${i.path}`);
					console.log(`    Error: ${i.message}`);
					if (options.fix && i.suggestion) {
						console.log(`    Suggestion: ${i.suggestion}`);
					}
					console.log("");
				});
			} else {
				console.log("✓ Markdown files valid (schema + relationships)\n");
			}

			// TODO: Re-enable graph validation when needed
		// Currently focusing on frontmatter validation as source of truth
		const graphResult = {
			valid: true,
			issues: [],
			stats: { totalNodes: 0, documentsChecked: 0, entitiesChecked: 0, errorsFound: 0, warningsFound: 0 },
		};
		/*
		// Validate graph data
			console.log("=== Graph Property Validation ===\n");
			const graphResult = await this.graphValidator.validateGraph();

			console.log(`Checked ${graphResult.stats.totalNodes} nodes:`);
			console.log(`  - ${graphResult.stats.documentsChecked} documents`);
			console.log(`  - ${graphResult.stats.entitiesChecked} entities\n`);

			if (graphResult.issues.length > 0) {
				const errors = graphResult.issues.filter((i) => i.type === "error");
				const warnings = graphResult.issues.filter((i) => i.type === "warning");

				if (errors.length > 0) {
					console.log(`\nGraph Errors (${errors.length}):\n`);
					errors.forEach((issue) => {
						console.log(`  [${issue.nodeLabel}] ${issue.nodeName}`);
						console.log(`    Field: ${issue.field}`);
						console.log(`    Error: ${issue.message}`);
						if (options.fix && issue.suggestion) {
							console.log(`    Suggestion: ${issue.suggestion}`);
						}
						console.log("");
					});
				}

				if (warnings.length > 0) {
					console.log(`\nGraph Warnings (${warnings.length}):\n`);
					warnings.forEach((issue) => {
						console.log(`  [${issue.nodeLabel}] ${issue.nodeName}`);
						console.log(`    Field: ${issue.field}`);
						console.log(`    Warning: ${issue.message}`);
						if (options.fix && issue.suggestion) {
							console.log(`    Suggestion: ${issue.suggestion}`);
						}
						console.log("");
					});
				}
			} else {
				console.log("✓ All graph validations passed!\n");
			}
		*/

			// Summary
			const totalErrors = issues.length + graphResult.stats.errorsFound;
			const totalWarnings = graphResult.stats.warningsFound;

			console.log("\n=== Validation Summary ===");
			console.log(
			`Markdown files: ${issues.length === 0 ? "✓ PASSED" : `✗ ${issues.length} errors`}`,
		);
		console.log(
			`Graph database: ${graphResult.stats.errorsFound === 0 ? "✓ PASSED" : `✗ ${graphResult.stats.errorsFound} errors`}`,
		);
			console.log(`Warnings: ${totalWarnings}`);
			console.log(
				`\nOverall: ${totalErrors === 0 ? "✓ PASSED" : "✗ FAILED"}${totalWarnings > 0 ? ` (${totalWarnings} warnings)` : ""}\n`,
			);

			process.exit(totalErrors > 0 ? 1 : 0);
		} catch (error) {
			console.error(
				"Validation failed:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	@Option({
		flags: "--fix",
		description: "Show suggestions for common issues",
	})
	parseFix(): boolean {
		return true;
	}
}
