/**
 * @fileoverview Unit tests for frontmatter utilities
 *
 * These test pure functions with no external dependencies.
 * Run fast (<100ms total).
 */

import { describe, expect, it } from "bun:test";
import {
	EntitySchema,
	EntityTypeSchema,
	FrontmatterSchema,
	GraphMetadataSchema,
	RelationshipSchema,
	RelationTypeSchema,
	generateFrontmatter,
	getCurrentDate,
	parseFrontmatter,
	validateFrontmatter,
	type FrontmatterData,
} from "./frontmatter.js";

describe("frontmatter utils", () => {
	describe("Zod Schemas", () => {
		describe("EntityTypeSchema", () => {
			it("accepts valid entity types", () => {
				const validTypes = [
					"Topic",
					"Technology",
					"Concept",
					"Tool",
					"Process",
					"Person",
					"Organization",
					"Document",
				];
				for (const type of validTypes) {
					expect(EntityTypeSchema.safeParse(type).success).toBe(true);
				}
			});

			it("rejects invalid entity types", () => {
				expect(EntityTypeSchema.safeParse("Invalid").success).toBe(false);
				expect(EntityTypeSchema.safeParse("").success).toBe(false);
			});
		});

		describe("RelationTypeSchema", () => {
			it("accepts REFERENCES", () => {
				expect(RelationTypeSchema.safeParse("REFERENCES").success).toBe(true);
			});

			it("rejects other relation types", () => {
				expect(RelationTypeSchema.safeParse("USES").success).toBe(false);
				expect(RelationTypeSchema.safeParse("DEPENDS_ON").success).toBe(false);
			});
		});

		describe("EntitySchema", () => {
			it("accepts valid entity with required fields", () => {
				const result = EntitySchema.safeParse({
					name: "TypeScript",
					type: "Technology",
				});
				expect(result.success).toBe(true);
			});

			it("accepts entity with optional description", () => {
				const result = EntitySchema.safeParse({
					name: "TypeScript",
					type: "Technology",
					description: "A typed superset of JavaScript",
				});
				expect(result.success).toBe(true);
			});

			it("rejects entity without name", () => {
				const result = EntitySchema.safeParse({ type: "Technology" });
				expect(result.success).toBe(false);
			});

			it("rejects entity with empty name", () => {
				const result = EntitySchema.safeParse({ name: "", type: "Technology" });
				expect(result.success).toBe(false);
			});
		});

		describe("RelationshipSchema", () => {
			it("accepts valid relationship", () => {
				const result = RelationshipSchema.safeParse({
					source: "MyApp",
					relation: "REFERENCES",
					target: "TypeScript",
				});
				expect(result.success).toBe(true);
			});

			it("rejects relationship with empty source", () => {
				const result = RelationshipSchema.safeParse({
					source: "",
					relation: "REFERENCES",
					target: "TypeScript",
				});
				expect(result.success).toBe(false);
			});
		});

		describe("GraphMetadataSchema", () => {
			it("accepts valid importance levels", () => {
				for (const importance of ["high", "medium", "low"]) {
					const result = GraphMetadataSchema.safeParse({ importance });
					expect(result.success).toBe(true);
				}
			});

			it("accepts domain field", () => {
				const result = GraphMetadataSchema.safeParse({ domain: "architecture" });
				expect(result.success).toBe(true);
			});

			it("accepts empty object", () => {
				const result = GraphMetadataSchema.safeParse({});
				expect(result.success).toBe(true);
			});
		});

		describe("FrontmatterSchema", () => {
			it("validates correct date format (YYYY-MM-DD)", () => {
				const result = FrontmatterSchema.safeParse({
					created: "2025-01-15",
					updated: "2025-12-07",
				});
				expect(result.success).toBe(true);
			});

			it("rejects invalid date format", () => {
				const result = FrontmatterSchema.safeParse({
					created: "01-15-2025", // MM-DD-YYYY
					updated: "2025-12-07",
				});
				expect(result.success).toBe(false);
			});

			it("rejects invalid calendar date (Feb 30)", () => {
				const result = FrontmatterSchema.safeParse({
					created: "2025-02-30",
					updated: "2025-12-07",
				});
				expect(result.success).toBe(false);
			});

			it("accepts leap year Feb 29", () => {
				const result = FrontmatterSchema.safeParse({
					created: "2024-02-29", // 2024 is a leap year
					updated: "2024-02-29",
				});
				expect(result.success).toBe(true);
			});

			it("rejects non-leap year Feb 29", () => {
				const result = FrontmatterSchema.safeParse({
					created: "2025-02-29", // 2025 is not a leap year
					updated: "2025-12-07",
				});
				expect(result.success).toBe(false);
			});

			it("accepts valid status values", () => {
				for (const status of ["draft", "ongoing", "complete"]) {
					const result = FrontmatterSchema.safeParse({
						created: "2025-01-01",
						updated: "2025-01-01",
						status,
					});
					expect(result.success).toBe(true);
				}
			});

			it("preserves custom fields via passthrough", () => {
				const result = FrontmatterSchema.safeParse({
					created: "2025-01-01",
					updated: "2025-01-01",
					customField: "preserved",
					anotherField: 123,
				});
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.data.customField).toBe("preserved");
					expect(result.data.anotherField).toBe(123);
				}
			});
		});
	});

	describe("parseFrontmatter()", () => {
		it("parses valid frontmatter", () => {
			const content = `---
created: 2025-01-15
updated: 2025-12-07
status: ongoing
---
# My Document

Content here...`;

			const result = parseFrontmatter(content);
			expect(result.frontmatter).not.toBeNull();
			expect(result.frontmatter?.created).toBe("2025-01-15");
			expect(result.frontmatter?.updated).toBe("2025-12-07");
			expect(result.frontmatter?.status).toBe("ongoing");
			expect(result.content).toBe("# My Document\n\nContent here...");
		});

		it("returns null frontmatter for content without frontmatter", () => {
			const content = "# Just a heading\n\nSome content";
			const result = parseFrontmatter(content);
			expect(result.frontmatter).toBeNull();
			expect(result.content).toBe("# Just a heading\n\nSome content");
		});

		it("preserves raw content", () => {
			const content = `---
created: 2025-01-01
updated: 2025-01-01
---
# Test`;
			const result = parseFrontmatter(content);
			expect(result.raw).toBe(content);
		});

		it("handles tags array", () => {
			const content = `---
created: 2025-01-01
updated: 2025-01-01
tags: [research, typescript]
---
Content`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter?.tags).toEqual(["research", "typescript"]);
		});

		it("handles entities array", () => {
			const content = `---
created: 2025-01-01
updated: 2025-01-01
entities:
  - name: TypeScript
    type: Technology
  - name: NestJS
    type: Tool
    description: A framework
---
Content`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter?.entities).toHaveLength(2);
			expect(result.frontmatter?.entities?.[0]).toEqual({
				name: "TypeScript",
				type: "Technology",
			});
		});

		it("handles relationships array", () => {
			const content = `---
created: 2025-01-01
updated: 2025-01-01
relationships:
  - source: MyApp
    relation: REFERENCES
    target: TypeScript
---
Content`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter?.relationships).toHaveLength(1);
			expect(result.frontmatter?.relationships?.[0]).toEqual({
				source: "MyApp",
				relation: "REFERENCES",
				target: "TypeScript",
			});
		});

		it("handles graph metadata", () => {
			const content = `---
created: 2025-01-01
updated: 2025-01-01
graph:
  importance: high
  domain: architecture
---
Content`;
			const result = parseFrontmatter(content);
			expect(result.frontmatter?.graph).toEqual({
				importance: "high",
				domain: "architecture",
			});
		});

		it("throws on malformed YAML", () => {
			const content = `---
created: 2025-01-01
  bad indentation: here
---
Content`;
			expect(() => parseFrontmatter(content)).toThrow("YAML parsing error");
		});

		it("converts Date objects to strings (gray-matter behavior)", () => {
			// gray-matter auto-converts YYYY-MM-DD to Date objects
			// Our normalizeData function should convert them back
			const content = `---
created: 2025-01-15
updated: 2025-12-07
---
Content`;
			const result = parseFrontmatter(content);
			expect(typeof result.frontmatter?.created).toBe("string");
			expect(result.frontmatter?.created).toBe("2025-01-15");
		});
	});

	describe("validateFrontmatter()", () => {
		it("returns valid for correct frontmatter", () => {
			const frontmatter: FrontmatterData = {
				created: "2025-01-15",
				updated: "2025-12-07",
				status: "ongoing",
			};
			const result = validateFrontmatter(frontmatter);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("returns errors for null frontmatter", () => {
			const result = validateFrontmatter(null);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("No frontmatter found");
		});

		it("returns errors for invalid date format", () => {
			const frontmatter = {
				created: "invalid-date",
				updated: "2025-12-07",
			} as FrontmatterData;
			const result = validateFrontmatter(frontmatter);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("created"))).toBe(true);
		});

		it("returns errors for invalid status", () => {
			const frontmatter = {
				created: "2025-01-01",
				updated: "2025-01-01",
				status: "invalid-status",
			} as FrontmatterData;
			const result = validateFrontmatter(frontmatter);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("status"))).toBe(true);
		});

		it("returns multiple errors when multiple fields are invalid", () => {
			const frontmatter = {
				created: "bad-date",
				updated: "also-bad",
			} as FrontmatterData;
			const result = validateFrontmatter(frontmatter);
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("generateFrontmatter()", () => {
		it("generates valid YAML for basic fields", () => {
			const data: FrontmatterData = {
				created: "2025-01-15",
				updated: "2025-12-07",
				status: "ongoing",
			};
			const result = generateFrontmatter(data);
			expect(result).toContain("---");
			expect(result).toContain("created: 2025-01-15");
			expect(result).toContain("updated: 2025-12-07");
			expect(result).toContain("status: ongoing");
		});

		it("generates valid YAML for tags array", () => {
			const data: FrontmatterData = {
				created: "2025-01-01",
				updated: "2025-01-01",
				tags: ["research", "typescript"],
			};
			const result = generateFrontmatter(data);
			expect(result).toContain("tags: [research, typescript]");
		});

		it("quotes strings with special characters", () => {
			const data: FrontmatterData = {
				created: "2025-01-01",
				updated: "2025-01-01",
				summary: "Contains: colons and #hashes",
			};
			const result = generateFrontmatter(data);
			expect(result).toContain('"Contains: colons and #hashes"');
		});

		it("quotes YAML reserved words", () => {
			const data: FrontmatterData = {
				created: "2025-01-01",
				updated: "2025-01-01",
				someField: "true", // string "true", not boolean
			};
			const result = generateFrontmatter(data);
			expect(result).toContain('"true"');
		});

		it("handles boolean values without quoting", () => {
			const data: FrontmatterData = {
				created: "2025-01-01",
				updated: "2025-01-01",
				isPublished: true,
			};
			const result = generateFrontmatter(data);
			expect(result).toContain("isPublished: true");
		});

		it("handles null values", () => {
			const data: FrontmatterData = {
				created: "2025-01-01",
				updated: "2025-01-01",
				optional: null,
			};
			const result = generateFrontmatter(data);
			expect(result).toContain("optional: null");
		});

		it("generates valid YAML for entities array", () => {
			const data: FrontmatterData = {
				created: "2025-01-01",
				updated: "2025-01-01",
				entities: [
					{ name: "TypeScript", type: "Technology" },
					{ name: "NestJS", type: "Tool", description: "A framework" },
				],
			};
			const result = generateFrontmatter(data);
			expect(result).toContain("entities:");
			expect(result).toContain("name: TypeScript");
			expect(result).toContain("type: Technology");
		});

		it("generates valid YAML for graph metadata", () => {
			const data: FrontmatterData = {
				created: "2025-01-01",
				updated: "2025-01-01",
				graph: {
					importance: "high",
					domain: "architecture",
				},
			};
			const result = generateFrontmatter(data);
			expect(result).toContain("graph:");
			expect(result).toContain("importance: high");
			expect(result).toContain("domain: architecture");
		});

		it("round-trips through parseFrontmatter", () => {
			const original: FrontmatterData = {
				created: "2025-01-15",
				updated: "2025-12-07",
				status: "ongoing",
				tags: ["test", "roundtrip"],
			};
			const yaml = generateFrontmatter(original);
			const parsed = parseFrontmatter(yaml + "\nContent");
			expect(parsed.frontmatter?.created).toBe(original.created);
			expect(parsed.frontmatter?.updated).toBe(original.updated);
			expect(parsed.frontmatter?.status).toBe(original.status);
			expect(parsed.frontmatter?.tags).toEqual(original.tags);
		});
	});

	describe("getCurrentDate()", () => {
		it("returns date in YYYY-MM-DD format", () => {
			const result = getCurrentDate();
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("returns a valid date that passes schema validation", () => {
			const result = getCurrentDate();
			const validation = FrontmatterSchema.safeParse({
				created: result,
				updated: result,
			});
			expect(validation.success).toBe(true);
		});
	});
});
