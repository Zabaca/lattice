import { Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { OntologyService } from '../sync/ontology.service.js';

@Injectable()
@Command({
	name: 'ontology',
	description: 'Derive and display ontology from all documents',
})
export class OntologyCommand extends CommandRunner {
	constructor(private readonly ontologyService: OntologyService) {
		super();
	}

	async run(): Promise<void> {
		try {
			const ontology = await this.ontologyService.deriveOntology();
			this.ontologyService.printSummary(ontology);
			process.exit(0);
		} catch (error) {
			console.error(
				'\n❌ Ontology derivation failed:',
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}
}
