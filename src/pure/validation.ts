/**
 * Pure functions for document validation
 * Extracted from SyncService for testability without mocks
 */
import type { ParsedDocument } from "../sync/document-parser.service.js";
import type { ChangeType } from "../sync/manifest.service.js";

/**
 * Validation error for a document
 */
export interface ValidationError {
	path: string;
	error: string;
}

/**
 * Validate documents for property completeness and relationship errors.
 * Returns array of validation errors. Empty array means validation passed.
 */
export function validateDocuments(docs: ParsedDocument[]): ValidationError[] {
	const errors: ValidationError[] = [];

	// Validate document properties
	for (const doc of docs) {
		// Required fields for documents
		if (!doc.title || doc.title.trim() === "") {
			errors.push({
				path: doc.path,
				error: "Missing required field: title",
			});
		}

		if (!doc.summary || doc.summary.trim() === "") {
			errors.push({
				path: doc.path,
				error: "Missing required field: summary",
			});
		}

		if (!doc.created) {
			errors.push({
				path: doc.path,
				error: "Missing required field: created",
			});
		}

		if (!doc.updated) {
			errors.push({
				path: doc.path,
				error: "Missing required field: updated",
			});
		}

		if (!doc.status) {
			errors.push({
				path: doc.path,
				error: "Missing required field: status",
			});
		}

		// Note: Entity validation (name, type, description) is handled by Zod schema
		// in document-parser.service.ts during parsing. No need to duplicate here.
	}

	// Build entity index (name -> documents defining it)
	const entityIndex = new Map<string, Set<string>>();
	for (const doc of docs) {
		for (const entity of doc.entities) {
			let docSet = entityIndex.get(entity.name);
			if (!docSet) {
				docSet = new Set<string>();
				entityIndex.set(entity.name, docSet);
			}
			docSet.add(doc.path);
		}
	}

	// Validate relationships
	for (const doc of docs) {
		for (const rel of doc.relationships) {
			// Check source exists (unless it's the document itself via 'this' replacement)
			if (rel.source !== doc.path && !entityIndex.has(rel.source)) {
				errors.push({
					path: doc.path,
					error: `Relationship source "${rel.source}" not found in any document`,
				});
			}

			// Check target exists (could be entity or document path)
			const isDocPath = rel.target.endsWith(".md");
			const isKnownEntity = entityIndex.has(rel.target);
			const isSelfReference = rel.target === doc.path;

			if (!isDocPath && !isKnownEntity && !isSelfReference) {
				errors.push({
					path: doc.path,
					error: `Relationship target "${rel.target}" not found as entity`,
				});
			}
		}
	}

	return errors;
}

/**
 * Get human-readable reason for change type
 */
export function getChangeReason(changeType: ChangeType): string {
	switch (changeType) {
		case "new":
			return "New document";
		case "updated":
			return "Content or frontmatter changed";
		case "deleted":
			return "File no longer exists";
		case "unchanged":
			return "No changes detected";
	}
}
