import { Command } from 'commander';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { DocumentParserService } from '../sync/document-parser.service.js';
import { validateDocuments } from '../sync/sync.service.js';

interface ValidationIssue {
	type: 'error';
	path: string;
	message: string;
	suggestion?: string;
}

export function registerValidateCommand(program: Command) {
	program
		.command('validate')
		.description('Validate entity references and relationships across documents')
		.option('--fix', 'Show suggestions for common issues')
		.action(async (options) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: false,
				});
				const parser = app.get(DocumentParserService);

				console.log('Validating entities and relationships...\n');

				const { docs, errors: schemaErrors } = await parser.parseAllDocumentsWithErrors();
				const issues: ValidationIssue[] = [];

				// Add schema errors (invalid frontmatter format)
				for (const schemaError of schemaErrors) {
					issues.push({
						type: 'error',
						path: schemaError.path,
						message: schemaError.error,
					});
				}

				// Count unique entities for output
				const entityIndex = new Map<string, Set<string>>();
				for (const doc of docs) {
					for (const entity of doc.entities) {
						if (!entityIndex.has(entity.name)) {
							entityIndex.set(entity.name, new Set());
						}
						entityIndex.get(entity.name)!.add(doc.path);
					}
				}

				// Validate relationships using shared function
				const validationErrors = validateDocuments(docs);
				for (const err of validationErrors) {
					issues.push({
						type: 'error',
						path: err.path,
						message: err.error,
						suggestion: 'Add entity definition or fix the reference',
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
						console.log('');
					});
				}

				if (issues.length === 0) {
					console.log('All validations passed!');
				}

				await app.close();
				process.exit(issues.length > 0 ? 1 : 0);
			} catch (error) {
				console.error(
					'Validation failed:',
					error instanceof Error ? error.message : String(error)
				);
				if (app) await app.close();
				process.exit(1);
			}
		});
}
