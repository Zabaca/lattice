/**
 * Frontmatter utilities for research documentation
 *
 * Utilities for research documentation workflows including:
 * - Markdown frontmatter parsing
 * - File metadata extraction
 * - Research document validation
 */

import matter from "gray-matter";
import { z } from "zod";

/**
 * Entity type enum
 */
export const EntityTypeSchema = z.enum([
	"Topic",
	"Technology",
	"Concept",
	"Tool",
	"Process",
	"Person",
	"Organization",
	"Document",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

/**
 * Relationship type enum
 * Simplified ontology: only REFERENCES is user-declarable
 * APPEARS_IN is auto-generated when entities appear in documents
 */
export const RelationTypeSchema = z.enum(["REFERENCES"]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

/**
 * Entity definition
 */
export const EntitySchema = z.object({
	name: z.string().min(1),
	type: EntityTypeSchema,
	description: z.string().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

/**
 * Relationship definition
 */
export const RelationshipSchema = z.object({
	source: z.string().min(1), // Entity name or 'this' for current doc
	relation: RelationTypeSchema,
	target: z.string().min(1), // Entity name or relative path
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/**
 * Graph metadata
 */
export const GraphMetadataSchema = z.object({
	importance: z.enum(["high", "medium", "low"]).optional(),
	domain: z.string().optional(),
});
export type GraphMetadata = z.infer<typeof GraphMetadataSchema>;

/**
 * Validate date string is in valid YYYY-MM-DD format and represents a real date
 */
const validateDateFormat = (dateStr: string) => {
	const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return false;

	const [, yearStr, monthStr, dayStr] = match;
	const year = parseInt(yearStr, 10);
	const month = parseInt(monthStr, 10);
	const day = parseInt(dayStr, 10);

	// Basic validation: month 1-12, day 1-31
	if (month < 1 || month > 12) return false;
	if (day < 1 || day > 31) return false;

	// More precise validation for specific months
	const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

	// Check for leap year
	if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) {
		daysInMonth[1] = 29;
	}

	return day <= daysInMonth[month - 1];
};

/**
 * Zod schema for research document frontmatter
 *
 * Validates core fields while allowing custom research-specific metadata via .passthrough()
 *
 * Core fields:
 * - created: Date in YYYY-MM-DD format (required)
 * - updated: Date in YYYY-MM-DD format (required)
 * - status: 'draft' | 'ongoing' | 'complete' (optional)
 * - topic: Research topic name, auto-derived from directory (optional)
 * - tags: Array of string tags (optional)
 * - summary: AI-generated document summary for embeddings (optional)
 * - entities: Array of Entity objects for knowledge graph (optional)
 * - relationships: Array of Relationship objects for knowledge graph (optional)
 * - graph: Graph metadata for knowledge graph integration (optional)
 *
 * Custom fields: Any additional fields are preserved through .passthrough()
 */
export const FrontmatterSchema = z
	.object({
		created: z
			.string()
			.refine(validateDateFormat, "Date must be in YYYY-MM-DD format"),
		updated: z
			.string()
			.refine(validateDateFormat, "Date must be in YYYY-MM-DD format"),
		status: z.enum(["draft", "ongoing", "complete"]).optional(),
		topic: z.string().optional(),
		tags: z.array(z.string()).optional(),
		summary: z.string().optional(),
		entities: z.array(EntitySchema).optional(),
		relationships: z.array(RelationshipSchema).optional(),
		graph: GraphMetadataSchema.optional(),
	})
	.passthrough();

/**
 * Inferred TypeScript type from FrontmatterSchema
 *
 * This type allows:
 * - All standard fields (created, updated, status, tags) as optional
 * - Any additional custom fields via index signature
 */
export type FrontmatterData = z.infer<typeof FrontmatterSchema> & {
	[key: string]: any;
};

export interface ParsedDocument {
	frontmatter: FrontmatterData | null;
	content: string;
	raw: string;
}

/**
 * Parse YAML frontmatter from markdown content
 *
 * Uses gray-matter for robust YAML parsing with support for:
 * - Windows (\r\n) and Unix (\n) line endings
 * - YAML comments
 * - Nested objects
 * - Multi-line values
 * - Arrays in multiple formats
 * - All valid YAML syntax
 *
 * Validates parsed frontmatter using Zod schema for type safety.
 *
 * @param content - Raw markdown content with optional YAML frontmatter
 * @returns Parsed document with separated frontmatter and content
 *
 * @example
 * ```ts
 * const doc = parseFrontmatter(`---
 * created: 2025-11-24
 * status: ongoing
 * ---
 * # My Research
 * Content here...`);
 *
 * console.log(doc.frontmatter.status); // 'ongoing'
 * console.log(doc.content); // '# My Research\nContent here...'
 * ```
 */
export function parseFrontmatter(content: string): ParsedDocument {
	try {
		// Parse frontmatter using gray-matter
		// Note: gray-matter uses js-yaml which auto-converts YYYY-MM-DD to Date objects
		// We convert them back to strings to maintain backward compatibility
		const { data, content: markdown } = matter(content);

		// If no frontmatter was found, gray-matter returns empty object
		if (Object.keys(data).length === 0) {
			return {
				frontmatter: null,
				content: markdown.trim(),
				raw: content,
			};
		}

		// Convert Date objects back to YYYY-MM-DD strings for backward compatibility
		const normalizedData = normalizeData(data);

		// Validate with Zod schema (preserves custom fields via .passthrough())
		const validated = FrontmatterSchema.safeParse(normalizedData);

		// Return parsed data regardless of validation
		// Validation errors can be checked separately using validateFrontmatter()
		return {
			frontmatter: validated.success
				? validated.data
				: (normalizedData as FrontmatterData),
			content: markdown.trim(),
			raw: content,
		};
	} catch (error) {
		// Re-throw YAML parsing errors - these should not be silent failures
		// Callers need to know about malformed frontmatter to fix it
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`YAML parsing error: ${errorMessage}`);
	}
}

/**
 * Helper function to normalize data parsed by gray-matter
 * Converts Date objects back to YYYY-MM-DD strings for backward compatibility
 */
function normalizeData(data: any): any {
	if (data instanceof Date) {
		return data.toISOString().split("T")[0];
	}

	if (Array.isArray(data)) {
		return data.map(normalizeData);
	}

	if (data !== null && typeof data === "object") {
		const normalized: any = {};
		for (const [key, value] of Object.entries(data)) {
			normalized[key] = normalizeData(value);
		}
		return normalized;
	}

	return data;
}

/**
 * Validate research document frontmatter using Zod schema
 *
 * @param frontmatter - Frontmatter data to validate
 * @returns Validation result with errors if any
 *
 * @example
 * ```ts
 * const result = validateFrontmatter({
 *   created: '2025-11-24',
 *   updated: '2025-11-24',
 *   status: 'ongoing',
 *   tags: ['research', 'tesla'],
 *   price_range: '$30k' // custom field preserved
 * });
 *
 * if (!result.valid) {
 *   console.error('Validation errors:', result.errors);
 * }
 * ```
 */
export function validateFrontmatter(frontmatter: FrontmatterData | null): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (!frontmatter) {
		errors.push("No frontmatter found");
		return { valid: false, errors };
	}

	// Use Zod schema for validation
	const result = FrontmatterSchema.safeParse(frontmatter);

	if (!result.success) {
		// Extract Zod validation errors and format with field path
		// Note: Zod v4 changed .errors to .issues
		result.error.issues.forEach((err) => {
			const field = err.path.length > 0 ? err.path.join(".") : "value";
			const fieldLabel = field || "value";
			errors.push(`${fieldLabel}: ${err.message}`);
		});
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Check if a value needs to be quoted in YAML
 * Values need quoting if they:
 * - Are empty strings
 * - Contain special YAML characters (colons, hashes, brackets, etc.)
 * - Are YAML reserved words (true, false, null, etc.)
 * - Contain leading/trailing whitespace
 *
 * @param value - The value to check
 * @returns true if the value should be quoted
 */
function needsQuoting(value: any): boolean {
	// Null and booleans don't need quoting
	if (value === null || typeof value === "boolean") {
		return false;
	}

	// Non-string primitives don't need quoting
	if (typeof value !== "string" && !Array.isArray(value)) {
		return false;
	}

	// Arrays are handled separately
	if (Array.isArray(value)) {
		return false;
	}

	const str = String(value);

	// Empty strings need quoting
	if (str === "") {
		return true;
	}

	// Strings with leading/trailing whitespace need quoting
	if (str !== str.trim()) {
		return true;
	}

	// Strings containing special YAML characters need quoting
	// This includes: colons, hashes, brackets, braces, etc.
	if (/[:#[\]{}!&*,|>'"?%@`\\]|^-|:\s/.test(str)) {
		return true;
	}

	// YAML reserved words need quoting
	const yamlReserved = [
		"null",
		"true",
		"false",
		"yes",
		"no",
		"on",
		"off",
		"nil",
	];
	if (yamlReserved.includes(str.toLowerCase())) {
		return true;
	}

	return false;
}

/**
 * Generate YAML value (helper for generateFrontmatter)
 * Recursively handles objects and arrays of objects
 */
function generateYamlValue(value: any, indent: number = 0): string {
	const indentStr = " ".repeat(indent);

	if (value === null) {
		return "null";
	}

	if (typeof value === "boolean") {
		return String(value);
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (typeof value === "string") {
		if (needsQuoting(value)) {
			return `"${value.replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	if (Array.isArray(value)) {
		// Check if array contains objects
		if (
			value.length > 0 &&
			typeof value[0] === "object" &&
			!Array.isArray(value[0])
		) {
			// Format as YAML block array with objects
			const items = value.map((item) => {
				const objLines = [`${indentStr}  - `];
				let first = true;
				for (const [k, v] of Object.entries(item)) {
					const yamlVal = generateYamlValue(v, indent + 4);
					if (first) {
						objLines[0] += `${k}: ${yamlVal}`;
						first = false;
					} else {
						objLines.push(`${indentStr}    ${k}: ${yamlVal}`);
					}
				}
				return objLines.join("\n");
			});
			return "\n" + items.join("\n");
		} else {
			// Format as inline array for primitives
			const quotedItems = value.map((item) => {
				if (typeof item === "string" && needsQuoting(item)) {
					return `"${item.replace(/"/g, '\\"')}"`;
				}
				return String(item);
			});
			return `[${quotedItems.join(", ")}]`;
		}
	}

	if (typeof value === "object") {
		// Format as YAML block object
		const objLines: string[] = [];
		for (const [k, v] of Object.entries(value)) {
			const yamlVal = generateYamlValue(v, indent + 2);
			if (yamlVal.startsWith("\n")) {
				objLines.push(`${indentStr}  ${k}:${yamlVal}`);
			} else {
				objLines.push(`${indentStr}  ${k}: ${yamlVal}`);
			}
		}
		return "\n" + objLines.join("\n");
	}

	return String(value);
}

/**
 * Generate frontmatter YAML string
 *
 * Produces valid YAML frontmatter that is compatible with gray-matter parser.
 * Properly quotes strings containing special characters or empty values.
 * Handles nested objects and arrays of objects for graph metadata.
 *
 * @param data - Frontmatter data object
 * @returns YAML frontmatter string compatible with gray-matter
 */
export function generateFrontmatter(data: FrontmatterData): string {
	const lines = ["---"];

	for (const [key, value] of Object.entries(data)) {
		const yamlVal = generateYamlValue(value);
		if (yamlVal.startsWith("\n")) {
			lines.push(`${key}:${yamlVal}`);
		} else {
			lines.push(`${key}: ${yamlVal}`);
		}
	}

	lines.push("---");
	return lines.join("\n");
}

/**
 * Get current date in YYYY-MM-DD format
 */
export function getCurrentDate(): string {
	const now = new Date();
	return now.toISOString().split("T")[0];
}
