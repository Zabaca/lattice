/**
 * Pure functions for composing embedding text from documents and entities
 * Extracted from SyncService for testability without mocks
 */
import type { ParsedDocument } from "../sync/document-parser.service.js";
import type { UniqueEntity } from "../sync/sync.service.js";

/**
 * Compose rich text for embedding from multiple document fields
 * Format: "Title: X | Topic: Y | Tags: a, b, c | Entities: d, e, f | Summary"
 */
export function composeDocumentEmbeddingText(doc: ParsedDocument): string {
	const parts: string[] = [];

	if (doc.title) {
		parts.push(`Title: ${doc.title}`);
	}

	if (doc.topic) {
		parts.push(`Topic: ${doc.topic}`);
	}

	if (doc.tags && doc.tags.length > 0) {
		parts.push(`Tags: ${doc.tags.join(", ")}`);
	}

	if (doc.entities && doc.entities.length > 0) {
		const entityNames = doc.entities.map((e) => e.name).join(", ");
		parts.push(`Entities: ${entityNames}`);
	}

	if (doc.summary) {
		parts.push(doc.summary);
	} else {
		parts.push(doc.content.slice(0, 500));
	}

	return parts.join(" | ");
}

/**
 * Compose embedding text for an entity.
 * Format: "Type: Name. Description (if available)"
 */
export function composeEntityEmbeddingText(entity: UniqueEntity): string {
	const parts = [`${entity.type}: ${entity.name}`];
	if (entity.description) {
		parts.push(entity.description);
	}
	return parts.join(". ");
}

/**
 * Collect unique entities from all parsed documents with in-code deduplication.
 * Key: "type:name" for deduplication
 * When same entity appears in multiple docs, keep the longest description.
 */
export function collectUniqueEntities(
	docs: ParsedDocument[],
): Map<string, UniqueEntity> {
	const entities = new Map<string, UniqueEntity>();

	for (const doc of docs) {
		for (const entity of doc.entities) {
			const key = `${entity.type}:${entity.name}`;
			const existing = entities.get(key);

			if (!existing) {
				entities.set(key, {
					type: entity.type,
					name: entity.name,
					description: entity.description,
					documentPaths: [doc.path],
				});
			} else {
				// Merge: keep longest description, track all doc paths
				existing.documentPaths.push(doc.path);
				if (
					entity.description &&
					(!existing.description ||
						entity.description.length > existing.description.length)
				) {
					existing.description = entity.description;
				}
			}
		}
	}

	return entities;
}
