import { describe, it, expect, beforeEach } from 'bun:test';
import { OntologyService } from './ontology.service.js';
import { ParsedDocument } from './document-parser.service.js';

describe('OntologyService', () => {
	let service: OntologyService;

	// Mock DocumentParserService
	const mockParserService = {
		parseAllDocuments: async () => [],
	};

	beforeEach(() => {
		service = new OntologyService(mockParserService as any);
	});

	describe('deriveFromDocuments', () => {
		it('should handle empty documents', () => {
			const docs: ParsedDocument[] = [];
			const ontology = service.deriveFromDocuments(docs);

			expect(ontology.entityTypes).toEqual([]);
			expect(ontology.relationshipTypes).toEqual([]);
			expect(ontology.entityCounts).toEqual({});
			expect(ontology.relationshipCounts).toEqual({});
			expect(ontology.totalEntities).toBe(0);
			expect(ontology.totalRelationships).toBe(0);
			expect(ontology.documentsWithEntities).toBe(0);
			expect(ontology.documentsWithoutEntities).toBe(0);
		});

		it('should derive entity types from documents', () => {
			const docs: ParsedDocument[] = [
				{
					path: 'doc1.md',
					title: 'Doc 1',
					content: 'content',
					contentHash: 'hash1',
					frontmatterHash: 'hash2',
					entities: [
						{ name: 'Entity1', type: 'Person' },
						{ name: 'Entity2', type: 'Organization' },
						{ name: 'Entity3', type: 'Person' },
					],
					relationships: [],
					tags: [],
				},
			];

			const ontology = service.deriveFromDocuments(docs);

			expect(ontology.entityTypes).toEqual(['Organization', 'Person']);
			expect(ontology.entityCounts).toEqual({ Person: 2, Organization: 1 });
			expect(ontology.totalEntities).toBe(3);
			expect(ontology.documentsWithEntities).toBe(1);
			expect(ontology.documentsWithoutEntities).toBe(0);
		});

		it('should derive relationship types from documents', () => {
			const docs: ParsedDocument[] = [
				{
					path: 'doc1.md',
					title: 'Doc 1',
					content: 'content',
					contentHash: 'hash1',
					frontmatterHash: 'hash2',
					entities: [],
					relationships: [
						{ source: 'Entity1', target: 'Entity2', relation: 'WORKS_FOR' },
						{ source: 'Entity2', target: 'Entity3', relation: 'OWNS' },
						{ source: 'Entity1', target: 'Entity3', relation: 'WORKS_FOR' },
					],
					tags: [],
				},
			];

			const ontology = service.deriveFromDocuments(docs);

			expect(ontology.relationshipTypes).toEqual(['OWNS', 'WORKS_FOR']);
			expect(ontology.relationshipCounts).toEqual({ WORKS_FOR: 2, OWNS: 1 });
			expect(ontology.totalRelationships).toBe(3);
		});

		it('should track entity examples and document references', () => {
			const docs: ParsedDocument[] = [
				{
					path: 'doc1.md',
					title: 'Doc 1',
					content: 'content',
					contentHash: 'hash1',
					frontmatterHash: 'hash2',
					entities: [{ name: 'Entity1', type: 'Person' }],
					relationships: [],
					tags: [],
				},
				{
					path: 'doc2.md',
					title: 'Doc 2',
					content: 'content',
					contentHash: 'hash3',
					frontmatterHash: 'hash4',
					entities: [{ name: 'Entity1', type: 'Person' }],
					relationships: [],
					tags: [],
				},
			];

			const ontology = service.deriveFromDocuments(docs);

			expect(ontology.entityExamples['Entity1']).toBeDefined();
			expect(ontology.entityExamples['Entity1'].type).toBe('Person');
			expect(ontology.entityExamples['Entity1'].documents).toEqual(['doc1.md', 'doc2.md']);
		});

		it('should count documents with and without entities', () => {
			const docs: ParsedDocument[] = [
				{
					path: 'doc1.md',
					title: 'Doc 1',
					content: 'content',
					contentHash: 'hash1',
					frontmatterHash: 'hash2',
					entities: [{ name: 'Entity1', type: 'Person' }],
					relationships: [],
					tags: [],
				},
				{
					path: 'doc2.md',
					title: 'Doc 2',
					content: 'content',
					contentHash: 'hash3',
					frontmatterHash: 'hash4',
					entities: [],
					relationships: [],
					tags: [],
				},
				{
					path: 'doc3.md',
					title: 'Doc 3',
					content: 'content',
					contentHash: 'hash5',
					frontmatterHash: 'hash6',
					entities: [],
					relationships: [],
					tags: [],
				},
			];

			const ontology = service.deriveFromDocuments(docs);

			expect(ontology.documentsWithEntities).toBe(1);
			expect(ontology.documentsWithoutEntities).toBe(2);
		});

		it('should handle duplicate entity names avoiding duplicate documents', () => {
			const docs: ParsedDocument[] = [
				{
					path: 'doc1.md',
					title: 'Doc 1',
					content: 'content',
					contentHash: 'hash1',
					frontmatterHash: 'hash2',
					entities: [
						{ name: 'Entity1', type: 'Person' },
						{ name: 'Entity1', type: 'Person' },
					],
					relationships: [],
					tags: [],
				},
			];

			const ontology = service.deriveFromDocuments(docs);

			expect(ontology.entityExamples['Entity1'].documents).toEqual(['doc1.md']);
			expect(ontology.entityExamples['Entity1'].documents.length).toBe(1);
		});
	});
});
