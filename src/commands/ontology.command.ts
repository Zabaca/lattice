import { Command } from 'commander';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { OntologyService } from '../sync/ontology.service.js';

export function registerOntologyCommand(program: Command) {
	program
		.command('ontology')
		.description('Derive and display ontology from all documents')
		.action(async () => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: false,
				});
				const ontologyService = app.get(OntologyService);
				const ontology = await ontologyService.deriveOntology();
				ontologyService.printSummary(ontology);
				await app.close();
				process.exit(0);
			} catch (error) {
				console.error(
					'\n❌ Ontology derivation failed:',
					error instanceof Error ? error.message : String(error),
				);
				if (app) await app.close();
				process.exit(1);
			}
		});
}
