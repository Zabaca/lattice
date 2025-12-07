/**
 * Pure functions extracted for testability without mocks
 * Following the "Functional Core, Imperative Shell" pattern
 */

// Embedding text composition
export {
	collectUniqueEntities,
	composeDocumentEmbeddingText,
	composeEntityEmbeddingText,
} from "./embedding-text.js";
// Content hashing
export { getContentHash, getFrontmatterHash } from "./hashing.js";

// Document validation
export {
	getChangeReason,
	type ValidationError,
	validateDocuments,
} from "./validation.js";
