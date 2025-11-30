import { Injectable } from "@nestjs/common";
import {
	DocumentParserService,
	ParsedDocument,
} from "./document-parser.service.js";

export interface DerivedOntology {
	// Entity types in use
	entityTypes: string[];

	// Relationship types in use
	relationshipTypes: string[];

	// Count of entities per type
	entityCounts: Record<string, number>;

	// Count of relationships per type
	relationshipCounts: Record<string, number>;

	// Total unique entities
	totalEntities: number;

	// Total relationships
	totalRelationships: number;

	// Documents with entities
	documentsWithEntities: number;

	// Documents without entities
	documentsWithoutEntities: number;

	// Entity examples (name -> type)
	entityExamples: Record<string, { type: string; documents: string[] }>;
}

@Injectable()
export class OntologyService {
	constructor(private parser: DocumentParserService) {}

	// Derive ontology from all documents
	async deriveOntology(): Promise<DerivedOntology> {
		const docs = await this.parser.parseAllDocuments();
		return this.deriveFromDocuments(docs);
	}

	// Derive from specific documents (for testing)
	deriveFromDocuments(docs: ParsedDocument[]): DerivedOntology {
		const entityTypeSet = new Set<string>();
		const relationshipTypeSet = new Set<string>();
		const entityCounts: Record<string, number> = {};
		const relationshipCounts: Record<string, number> = {};
		const entityExamples: Record<
			string,
			{ type: string; documents: string[] }
		> = {};

		let documentsWithEntities = 0;
		let documentsWithoutEntities = 0;
		let totalRelationships = 0;

		for (const doc of docs) {
			if (doc.entities.length > 0) {
				documentsWithEntities++;
			} else {
				documentsWithoutEntities++;
			}

			// Process entities
			for (const entity of doc.entities) {
				entityTypeSet.add(entity.type);
				entityCounts[entity.type] = (entityCounts[entity.type] || 0) + 1;

				// Track examples
				if (!entityExamples[entity.name]) {
					entityExamples[entity.name] = { type: entity.type, documents: [] };
				}
				if (!entityExamples[entity.name].documents.includes(doc.path)) {
					entityExamples[entity.name].documents.push(doc.path);
				}
			}

			// Process relationships
			for (const rel of doc.relationships) {
				relationshipTypeSet.add(rel.relation);
				relationshipCounts[rel.relation] =
					(relationshipCounts[rel.relation] || 0) + 1;
				totalRelationships++;
			}
		}

		return {
			entityTypes: Array.from(entityTypeSet).sort(),
			relationshipTypes: Array.from(relationshipTypeSet).sort(),
			entityCounts,
			relationshipCounts,
			totalEntities: Object.keys(entityExamples).length,
			totalRelationships,
			documentsWithEntities,
			documentsWithoutEntities,
			entityExamples,
		};
	}

	// Print ontology summary
	printSummary(ontology: DerivedOntology): void {
		console.log("\nDerived Ontology Summary\n");
		console.log(
			`Documents: ${ontology.documentsWithEntities} with entities, ${ontology.documentsWithoutEntities} without`,
		);
		console.log(`Unique Entities: ${ontology.totalEntities}`);
		console.log(`Total Relationships: ${ontology.totalRelationships}`);

		console.log("\nEntity Types:");
		for (const type of ontology.entityTypes) {
			console.log(`  ${type}: ${ontology.entityCounts[type]} instances`);
		}

		console.log("\nRelationship Types:");
		for (const type of ontology.relationshipTypes) {
			console.log(`  ${type}: ${ontology.relationshipCounts[type]} instances`);
		}

		console.log("\nTop Entities (by document count):");
		const sorted = Object.entries(ontology.entityExamples)
			.sort((a, b) => b[1].documents.length - a[1].documents.length)
			.slice(0, 10);
		for (const [name, info] of sorted) {
			console.log(`  ${name} (${info.type}): ${info.documents.length} docs`);
		}
	}
}
