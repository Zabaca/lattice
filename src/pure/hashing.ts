/**
 * Pure functions for content hashing
 * Extracted from ManifestService for testability without mocks
 */
import { createHash } from "node:crypto";

/**
 * Get SHA256 hash (truncated to 16 chars) for content
 */
export function getContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Get hash for frontmatter object (JSON stringified)
 */
export function getFrontmatterHash(
	frontmatter: Record<string, unknown>,
): string {
	return getContentHash(JSON.stringify(frontmatter));
}
