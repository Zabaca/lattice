import { Injectable, Logger } from '@nestjs/common';
import { GraphService } from '../graph/graph.service.js';
import { DocumentParserService, ParsedDocument } from './document-parser.service.js';

/**
 * Types of changes that can trigger cascade detection
 */
export type CascadeTrigger =
	| 'entity_renamed'
	| 'entity_deleted'
	| 'entity_type_changed'
	| 'relationship_changed'
	| 'document_deleted';

/**
 * Suggested actions for affected documents
 */
export type SuggestedAction =
	| 'update_reference'
	| 'remove_reference'
	| 'review_content'
	| 'add_entity';

/**
 * Represents a change to an entity that might affect other documents
 */
export interface EntityChange {
	trigger: CascadeTrigger;
	entityName: string;
	oldValue?: string;
	newValue?: string;
	documentPath: string;
}

/**
 * A document affected by an entity change
 */
export interface AffectedDocument {
	path: string;
	reason: string;
	suggestedAction: SuggestedAction;
	confidence: 'high' | 'medium' | 'low';
	affectedEntities: string[];
}

/**
 * Full cascade analysis result
 */
export interface CascadeAnalysis {
	trigger: CascadeTrigger;
	sourceDocument: string;
	affectedDocuments: AffectedDocument[];
	summary: string;
}

/**
 * Service for detecting cascade impacts when documents change.
 *
 * When an entity is renamed, deleted, or has its type changed in one document,
 * this service finds all other documents that reference that entity and may
 * need to be updated.
 */
@Injectable()
export class CascadeService {
	private readonly logger = new Logger(CascadeService.name);

	constructor(
		private readonly graph: GraphService,
		// Parser is available for future use (e.g., reading document content for deeper analysis)
		private readonly _parser: DocumentParserService,
	) {}

	/**
	 * Analyze the impact of an entity change and find affected documents
	 */
	async analyzeEntityChange(change: EntityChange): Promise<CascadeAnalysis> {
		let affectedDocuments: AffectedDocument[] = [];
		let summary: string;

		switch (change.trigger) {
			case 'entity_renamed':
				affectedDocuments = await this.findAffectedByRename(
					change.entityName,
					change.newValue || '',
				);
				summary = `Entity "${change.oldValue}" was renamed to "${change.newValue}"`;
				break;

			case 'entity_deleted':
				affectedDocuments = await this.findAffectedByDeletion(change.entityName);
				summary = `Entity "${change.entityName}" was deleted`;
				break;

			case 'entity_type_changed':
				affectedDocuments = await this.findAffectedByTypeChange(
					change.entityName,
					change.oldValue || '',
					change.newValue || '',
				);
				summary = `Entity "${change.entityName}" type changed from "${change.oldValue}" to "${change.newValue}"`;
				break;

			case 'relationship_changed':
				affectedDocuments = await this.findAffectedByRelationshipChange(change.entityName);
				summary = `Relationship involving "${change.entityName}" was changed`;
				break;

			case 'document_deleted':
				affectedDocuments = await this.findAffectedByDocumentDeletion(change.documentPath);
				summary = `Document "${change.documentPath}" was deleted`;
				break;

			default:
				summary = `Unknown change type for entity "${change.entityName}"`;
		}

		// Filter out the source document from affected documents
		affectedDocuments = affectedDocuments.filter(
			doc => doc.path !== change.documentPath
		);

		return {
			trigger: change.trigger,
			sourceDocument: change.documentPath,
			affectedDocuments,
			summary,
		};
	}

	/**
	 * Detect entities that were renamed between document versions.
	 *
	 * Detection strategy:
	 * - Find entities in old doc that don't exist in new doc (by name)
	 * - Find entities in new doc that don't exist in old doc (by name)
	 * - Match removed/added pairs by type to infer renames
	 */
	detectEntityRenames(oldDoc: ParsedDocument, newDoc: ParsedDocument): EntityChange[] {
		const changes: EntityChange[] = [];

		const oldNames = new Set(oldDoc.entities.map(e => e.name));
		const newNames = new Set(newDoc.entities.map(e => e.name));

		// Find removed entities (in old but not in new)
		const removedEntities = oldDoc.entities.filter(e => !newNames.has(e.name));

		// Find added entities (in new but not in old)
		const addedEntities = newDoc.entities.filter(e => !oldNames.has(e.name));

		// Group by type for matching
		const removedByType = new Map<string, typeof removedEntities>();
		for (const entity of removedEntities) {
			const existing = removedByType.get(entity.type) || [];
			existing.push(entity);
			removedByType.set(entity.type, existing);
		}

		const addedByType = new Map<string, typeof addedEntities>();
		for (const entity of addedEntities) {
			const existing = addedByType.get(entity.type) || [];
			existing.push(entity);
			addedByType.set(entity.type, existing);
		}

		// Match removed and added entities by type (assume rename if same type)
		for (const [type, removed] of removedByType) {
			const added = addedByType.get(type) || [];

			// Pair up removed and added entities of the same type
			const pairCount = Math.min(removed.length, added.length);
			for (let i = 0; i < pairCount; i++) {
				changes.push({
					trigger: 'entity_renamed',
					entityName: removed[i].name,
					oldValue: removed[i].name,
					newValue: added[i].name,
					documentPath: oldDoc.path,
				});
			}
		}

		return changes;
	}

	/**
	 * Detect entities that were deleted between document versions.
	 *
	 * An entity is considered deleted if it exists in the old doc
	 * but not in the new doc, and cannot be matched to a rename.
	 */
	detectEntityDeletions(oldDoc: ParsedDocument, newDoc: ParsedDocument): EntityChange[] {
		const changes: EntityChange[] = [];

		const newNames = new Set(newDoc.entities.map(e => e.name));

		// Get renames to exclude from deletions
		const renames = this.detectEntityRenames(oldDoc, newDoc);
		const renamedNames = new Set(renames.map(r => r.oldValue));

		// Find entities that were truly deleted (not renamed)
		for (const entity of oldDoc.entities) {
			if (!newNames.has(entity.name) && !renamedNames.has(entity.name)) {
				changes.push({
					trigger: 'entity_deleted',
					entityName: entity.name,
					documentPath: oldDoc.path,
				});
			}
		}

		return changes;
	}

	/**
	 * Detect entities whose type changed between document versions.
	 */
	detectEntityTypeChanges(oldDoc: ParsedDocument, newDoc: ParsedDocument): EntityChange[] {
		const changes: EntityChange[] = [];

		// Build lookup map for new entities by name
		const newEntityMap = new Map(newDoc.entities.map(e => [e.name, e]));

		// Check each old entity
		for (const oldEntity of oldDoc.entities) {
			const newEntity = newEntityMap.get(oldEntity.name);

			if (newEntity && newEntity.type !== oldEntity.type) {
				changes.push({
					trigger: 'entity_type_changed',
					entityName: oldEntity.name,
					oldValue: oldEntity.type,
					newValue: newEntity.type,
					documentPath: oldDoc.path,
				});
			}
		}

		return changes;
	}

	/**
	 * Find documents affected by an entity rename.
	 *
	 * Queries the graph to find all documents that reference the old entity name.
	 */
	async findAffectedByRename(
		entityName: string,
		_newName: string,
	): Promise<AffectedDocument[]> {
		try {
			// Note: FalkorDB doesn't support parameterized queries the same way,
			// so we construct the query directly with escaped values
			const escapedName = this.escapeForCypher(entityName);
			const query = `
				MATCH (e {name: '${escapedName}'})-[:APPEARS_IN]->(d:Document)
				RETURN d.name, d.title
			`.trim();

			const result = await this.graph.query(query);

			return (result.resultSet || []).map((row) => ({
				path: row[0] as string,
				reason: `References "${entityName}" in entities`,
				suggestedAction: 'update_reference' as SuggestedAction,
				confidence: 'high' as const,
				affectedEntities: [entityName],
			}));
		} catch (error) {
			this.logger.warn(
				`Failed to find documents affected by rename: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	/**
	 * Find documents affected by an entity deletion.
	 */
	async findAffectedByDeletion(entityName: string): Promise<AffectedDocument[]> {
		try {
			const escapedName = this.escapeForCypher(entityName);
			const query = `
				MATCH (e {name: '${escapedName}'})-[:APPEARS_IN]->(d:Document)
				RETURN d.name, d.title
			`.trim();

			const result = await this.graph.query(query);

			return (result.resultSet || []).map((row) => ({
				path: row[0] as string,
				reason: `References deleted entity "${entityName}"`,
				suggestedAction: 'review_content' as SuggestedAction,
				confidence: 'high' as const,
				affectedEntities: [entityName],
			}));
		} catch (error) {
			this.logger.warn(
				`Failed to find documents affected by deletion: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	/**
	 * Find documents affected by an entity type change.
	 */
	async findAffectedByTypeChange(
		entityName: string,
		oldType: string,
		newType: string,
	): Promise<AffectedDocument[]> {
		try {
			const escapedName = this.escapeForCypher(entityName);
			const query = `
				MATCH (e {name: '${escapedName}'})-[:APPEARS_IN]->(d:Document)
				RETURN d.name, d.title
			`.trim();

			const result = await this.graph.query(query);

			return (result.resultSet || []).map((row) => ({
				path: row[0] as string,
				reason: `References "${entityName}" with type "${oldType}" (now "${newType}")`,
				suggestedAction: 'review_content' as SuggestedAction,
				confidence: 'medium' as const,
				affectedEntities: [entityName],
			}));
		} catch (error) {
			this.logger.warn(
				`Failed to find documents affected by type change: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	/**
	 * Find documents affected by a relationship change.
	 */
	async findAffectedByRelationshipChange(entityName: string): Promise<AffectedDocument[]> {
		try {
			const escapedName = this.escapeForCypher(entityName);
			const query = `
				MATCH (e {name: '${escapedName}'})-[r]->(d:Document)
				RETURN d.name, d.title, type(r) as relType
			`.trim();

			const result = await this.graph.query(query);

			return (result.resultSet || []).map((row) => ({
				path: row[0] as string,
				reason: `Has relationship with "${entityName}"`,
				suggestedAction: 'review_content' as SuggestedAction,
				confidence: 'medium' as const,
				affectedEntities: [entityName],
			}));
		} catch (error) {
			this.logger.warn(
				`Failed to find documents affected by relationship change: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	/**
	 * Find documents affected by a document deletion.
	 * This finds documents that link to the deleted document.
	 */
	async findAffectedByDocumentDeletion(documentPath: string): Promise<AffectedDocument[]> {
		try {
			const escapedPath = this.escapeForCypher(documentPath);
			const query = `
				MATCH (d:Document)-[r]->(deleted:Document {name: '${escapedPath}'})
				RETURN d.name, type(r) as relType
			`.trim();

			const result = await this.graph.query(query);

			return (result.resultSet || []).map((row) => ({
				path: row[0] as string,
				reason: `Links to deleted document "${documentPath}"`,
				suggestedAction: 'remove_reference' as SuggestedAction,
				confidence: 'high' as const,
				affectedEntities: [],
			}));
		} catch (error) {
			this.logger.warn(
				`Failed to find documents affected by document deletion: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	/**
	 * Compare two document versions and return all cascade impacts.
	 *
	 * @param oldDoc Previous version of the document (null for new documents)
	 * @param newDoc Current version of the document
	 */
	async analyzeDocumentChange(
		oldDoc: ParsedDocument | null,
		newDoc: ParsedDocument,
	): Promise<CascadeAnalysis[]> {
		// New documents don't generate cascade warnings
		if (!oldDoc) {
			return [];
		}

		const analyses: CascadeAnalysis[] = [];

		// Detect all types of changes
		const renames = this.detectEntityRenames(oldDoc, newDoc);
		const deletions = this.detectEntityDeletions(oldDoc, newDoc);
		const typeChanges = this.detectEntityTypeChanges(oldDoc, newDoc);

		// Analyze each change
		for (const change of renames) {
			const analysis = await this.analyzeEntityChange(change);
			if (analysis.affectedDocuments.length > 0) {
				analyses.push(analysis);
			}
		}

		for (const change of deletions) {
			const analysis = await this.analyzeEntityChange(change);
			if (analysis.affectedDocuments.length > 0) {
				analyses.push(analysis);
			}
		}

		for (const change of typeChanges) {
			const analysis = await this.analyzeEntityChange(change);
			if (analysis.affectedDocuments.length > 0) {
				analyses.push(analysis);
			}
		}

		return analyses;
	}

	/**
	 * Format cascade warnings for CLI output.
	 */
	formatWarnings(analyses: CascadeAnalysis[]): string {
		if (analyses.length === 0) {
			return '';
		}

		const lines: string[] = [];
		lines.push('\n=== Cascade Impact Detected ===\n');

		for (const analysis of analyses) {
			lines.push(analysis.summary);
			lines.push(`  Source: ${analysis.sourceDocument}`);
			lines.push('');

			if (analysis.affectedDocuments.length > 0) {
				lines.push(`  Affected documents (${analysis.affectedDocuments.length}):`);

				for (const doc of analysis.affectedDocuments) {
					lines.push(`    [${doc.confidence}] ${doc.path}`);
					lines.push(`      ${doc.reason}`);
					lines.push(`      -> Suggested: ${this.formatSuggestedAction(doc.suggestedAction, analysis)}`);
				}
			}
			lines.push('');
		}

		return lines.join('\n');
	}

	/**
	 * Format a suggested action for display.
	 */
	private formatSuggestedAction(action: SuggestedAction, analysis: CascadeAnalysis): string {
		switch (action) {
			case 'update_reference':
				if (analysis.trigger === 'entity_renamed') {
					// Extract new name from summary
					const match = analysis.summary.match(/renamed to "([^"]+)"/);
					const newName = match ? match[1] : 'new name';
					return `Update reference to "${newName}"`;
				}
				return 'Update reference';

			case 'remove_reference':
				return 'Remove broken reference';

			case 'review_content':
				return 'Review content for consistency';

			case 'add_entity':
				return 'Consider adding entity definition';

			default:
				return action;
		}
	}

	/**
	 * Escape a string for use in Cypher queries.
	 */
	private escapeForCypher(value: string): string {
		return value
			.replace(/\\/g, '\\\\')
			.replace(/'/g, "\\'")
			.replace(/"/g, '\\"');
	}
}
