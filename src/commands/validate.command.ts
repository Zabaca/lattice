import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { DocumentParserService } from "../sync/document-parser.service.js";
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
	constructor(private readonly parserService: DocumentParserService) {
		super();
	}

	async run(_inputs: string[], options: ValidateCommandOptions): Promise<void> {
		try {
			console.log("Validating entities and relationships...\n");

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

			// Output results
			console.log(`Scanned ${docs.length} documents`);
			console.log(`Found ${entityIndex.size} unique entities\n`);

			if (issues.length > 0) {
				console.log(`Errors (${issues.length}):\n`);
				issues.forEach((i) => {
					console.log(`  ${i.path}`);
					console.log(`    Error: ${i.message}`);
					if (options.fix && i.suggestion) {
						console.log(`    Suggestion: ${i.suggestion}`);
					}
					console.log("");
				});
			}

			if (issues.length === 0) {
				console.log("All validations passed!");
			}

			process.exit(issues.length > 0 ? 1 : 0);
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
