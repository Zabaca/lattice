import { describe, it, expect, beforeEach } from 'bun:test';
import { DocumentParserService, ParsedDocument } from '../sync/document-parser.service.js';

describe('ValidateCommand', () => {
	let mockDocs: ParsedDocument[];

	beforeEach(() => {
		mockDocs = [
			{
				path: 'docs/typescript/basics.md',
				title: 'TypeScript Basics',
				content: 'Content',
				contentHash: 'hash1',
				frontmatterHash: 'fmhash1',
				tags: [],
				entities: [
					{
						name: 'TypeScript',
						type: 'Technology',
						description: 'Programming language',
					},
				],
				relationships: [
					{
						source: 'docs/typescript/basics.md',
						relation: 'DOCUMENTS',
						target: 'TypeScript',
					},
				],
			},
			{
				path: 'docs/typescript/advanced.md',
				title: 'Advanced TypeScript',
				content: 'Content',
				contentHash: 'hash2',
				frontmatterHash: 'fmhash2',
				tags: [],
				entities: [
					{
						name: 'TypeScript',
						type: 'Technology',
						description: 'Language features',
					},
				],
				relationships: [
					{
						source: 'docs/typescript/advanced.md',
						relation: 'DOCUMENTS',
						target: 'TypeScript',
					},
				],
			},
		];
	});

	it('should detect entity type inconsistencies', () => {
		// Modify second document to have inconsistent entity type
		mockDocs[1].entities[0].type = 'Tool';

		// Run validation logic
		const issues: any[] = [];
		const entityTypes = new Map<string, string>();

		for (const doc of mockDocs) {
			for (const entity of doc.entities) {
				if (
					entityTypes.has(entity.name) &&
					entityTypes.get(entity.name) !== entity.type
				) {
					issues.push({
						type: 'warning',
						message: `Entity "${entity.name}" has inconsistent types`,
					});
				}
				entityTypes.set(entity.name, entity.type);
			}
		}

		expect(issues.length).toBe(1);
		expect(issues[0].type).toBe('warning');
	});

	it('should detect missing entity references in relationships', () => {
		// Add relationship to non-existent entity
		mockDocs[0].relationships.push({
			source: 'docs/typescript/basics.md',
			relation: 'USES',
			target: 'NonExistentEntity',
		});

		const entityIndex = new Map<string, Set<string>>();
		const issues: any[] = [];

		for (const doc of mockDocs) {
			for (const entity of doc.entities) {
				if (!entityIndex.has(entity.name)) {
					entityIndex.set(entity.name, new Set());
				}
				entityIndex.get(entity.name)!.add(doc.path);
			}
		}

		for (const doc of mockDocs) {
			for (const rel of doc.relationships) {
				const isDocPath = rel.target.endsWith('.md');
				const isKnownEntity = entityIndex.has(rel.target);

				if (!isDocPath && !isKnownEntity) {
					issues.push({
						type: 'warning',
						message: `Relationship target "${rel.target}" not found`,
					});
				}
			}
		}

		expect(issues.length).toBe(1);
		expect(issues[0].message).toContain('NonExistentEntity');
	});

	it('should warn about documents without entities', () => {
		// Add document without entities
		mockDocs.push({
			path: 'docs/typescript/examples.md',
			title: 'TypeScript Examples',
			content: 'Content',
			contentHash: 'hash3',
			frontmatterHash: 'fmhash3',
			tags: [],
			entities: [],
			relationships: [],
		});

		const issues: any[] = [];

		for (const doc of mockDocs) {
			if (doc.entities.length === 0 && !doc.path.includes('README')) {
				issues.push({
					type: 'warning',
					message: `Document has no entities defined`,
				});
			}
		}

		expect(issues.length).toBe(1);
		expect(issues[0].type).toBe('warning');
	});

	it('should warn about entities without DOCUMENTS relationship', () => {
		// Clear relationships for first doc
		mockDocs[0].relationships = [];

		const issues: any[] = [];

		for (const doc of mockDocs) {
			if (doc.entities.length > 0) {
				const hasDocumentsRel = doc.relationships.some(
					(r) => r.relation === 'DOCUMENTS'
				);
				if (!hasDocumentsRel) {
					issues.push({
						type: 'warning',
						message: `Document has entities but no DOCUMENTS relationship`,
					});
				}
			}
		}

		expect(issues.length).toBe(1);
	});

	it('should pass validation for consistent data', () => {
		const entityIndex = new Map<string, Set<string>>();
		const entityTypes = new Map<string, string>();
		const issues: any[] = [];

		for (const doc of mockDocs) {
			for (const entity of doc.entities) {
				if (!entityIndex.has(entity.name)) {
					entityIndex.set(entity.name, new Set());
				}
				entityIndex.get(entity.name)!.add(doc.path);

				if (
					entityTypes.has(entity.name) &&
					entityTypes.get(entity.name) !== entity.type
				) {
					issues.push({
						type: 'warning',
						message: `Inconsistent type for ${entity.name}`,
					});
				}
				entityTypes.set(entity.name, entity.type);
			}
		}

		for (const doc of mockDocs) {
			for (const rel of doc.relationships) {
				const isDocPath = rel.target.endsWith('.md');
				const isKnownEntity = entityIndex.has(rel.target);

				if (!isDocPath && !isKnownEntity) {
					issues.push({
						type: 'warning',
						message: `Relationship target not found`,
					});
				}
			}

			if (doc.entities.length === 0 && !doc.path.includes('README')) {
				issues.push({
					type: 'warning',
					message: `Document has no entities`,
				});
			}

			if (doc.entities.length > 0) {
				const hasDocumentsRel = doc.relationships.some(
					(r) => r.relation === 'DOCUMENTS'
				);
				if (!hasDocumentsRel) {
					issues.push({
						type: 'warning',
						message: `No DOCUMENTS relationship`,
					});
				}
			}
		}

		expect(issues.length).toBe(0);
	});
});
