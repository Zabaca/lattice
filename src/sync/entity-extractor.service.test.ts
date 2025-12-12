import { beforeEach, describe, expect, it } from "bun:test";
import { EntityExtractorService } from "./entity-extractor.service.js";

describe("EntityExtractorService", () => {
	let service: EntityExtractorService;

	beforeEach(() => {
		service = new EntityExtractorService();
	});

	describe("parseExtractionResult", () => {
		it("should parse valid JSON response", () => {
			const response = JSON.stringify({
				entities: [
					{
						name: "TypeScript",
						type: "Technology",
						description: "Programming language",
					},
					{
						name: "NestJS",
						type: "Technology",
						description: "Node.js framework",
					},
				],
				relationships: [
					{
						source: "this",
						relation: "REFERENCES",
						target: "TypeScript",
					},
				],
				summary: "Test document about TypeScript and NestJS.",
			});

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(true);
			expect(result.entities).toHaveLength(2);
			expect(result.entities[0].name).toBe("TypeScript");
			expect(result.entities[0].type).toBe("Technology");
			expect(result.relationships).toHaveLength(1);
			expect(result.summary).toContain("TypeScript");
		});

		it("should replace 'this' with file path in relationships", () => {
			const response = JSON.stringify({
				entities: [],
				relationships: [
					{
						source: "this",
						relation: "REFERENCES",
						target: "TypeScript",
					},
				],
				summary: "test",
			});

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.relationships[0].source).toBe("/test/doc.md");
			expect(result.relationships[0].target).toBe("TypeScript");
		});

		it("should handle JSON wrapped in code fences", () => {
			const response =
				'```json\n{"entities":[],"relationships":[],"summary":"test"}\n```';

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(true);
			expect(result.summary).toBe("test");
		});

		it("should handle JSON wrapped in code fences without json label", () => {
			const response =
				'```\n{"entities":[],"relationships":[],"summary":"test"}\n```';

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(true);
			expect(result.summary).toBe("test");
		});

		it("should handle invalid JSON gracefully", () => {
			const response = "not valid json {{{";

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(false);
			expect(result.error).toContain("JSON parse error");
			expect(result.entities).toHaveLength(0);
		});

		it("should skip invalid entities", () => {
			const response = JSON.stringify({
				entities: [
					{ name: "Valid", type: "Technology", description: "desc" },
					{ type: "Technology", description: "missing name" }, // Invalid
					"just a string", // Invalid
					null, // Invalid
					{ name: "", type: "Technology" }, // Invalid - empty name
				],
				relationships: [],
				summary: "test",
			});

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(true);
			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe("Valid");
		});

		it("should skip invalid relationships", () => {
			const response = JSON.stringify({
				entities: [],
				relationships: [
					{ source: "this", relation: "REFERENCES", target: "Valid" },
					{ source: "", relation: "REFERENCES", target: "Empty" }, // Invalid
					{ relation: "REFERENCES", target: "MissingSource" }, // Invalid
					"just a string", // Invalid
				],
				summary: "test",
			});

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(true);
			expect(result.relationships).toHaveLength(1);
			expect(result.relationships[0].target).toBe("Valid");
		});

		it("should handle empty entities and relationships arrays", () => {
			const response = JSON.stringify({
				entities: [],
				relationships: [],
				summary: "Summary only document",
			});

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(true);
			expect(result.entities).toHaveLength(0);
			expect(result.relationships).toHaveLength(0);
			expect(result.summary).toBe("Summary only document");
		});

		it("should handle missing fields gracefully", () => {
			const response = JSON.stringify({
				entities: [{ name: "Test", type: "Technology" }], // missing description
			});

			const result = service.parseExtractionResult(response, "/test/doc.md");

			expect(result.success).toBe(true);
			expect(result.entities[0].description).toBe("");
			expect(result.relationships).toHaveLength(0);
			expect(result.summary).toBe("");
		});
	});

	describe("normalizeEntityType", () => {
		it("should return exact matches (case-insensitive)", () => {
			expect(service.normalizeEntityType("Technology")).toBe("Technology");
			expect(service.normalizeEntityType("technology")).toBe("Technology");
			expect(service.normalizeEntityType("TECHNOLOGY")).toBe("Technology");
			expect(service.normalizeEntityType("Tool")).toBe("Tool");
			expect(service.normalizeEntityType("Concept")).toBe("Concept");
			expect(service.normalizeEntityType("Process")).toBe("Process");
			expect(service.normalizeEntityType("Person")).toBe("Person");
			expect(service.normalizeEntityType("Organization")).toBe("Organization");
			expect(service.normalizeEntityType("Document")).toBe("Document");
			expect(service.normalizeEntityType("Topic")).toBe("Topic");
		});

		it("should convert aliases to valid types", () => {
			// Tool aliases
			expect(service.normalizeEntityType("platform")).toBe("Tool");
			expect(service.normalizeEntityType("service")).toBe("Tool");

			// Technology aliases
			expect(service.normalizeEntityType("framework")).toBe("Technology");
			expect(service.normalizeEntityType("library")).toBe("Technology");
			expect(service.normalizeEntityType("language")).toBe("Technology");
			expect(service.normalizeEntityType("database")).toBe("Technology");

			// Concept aliases
			expect(service.normalizeEntityType("pattern")).toBe("Concept");
			expect(service.normalizeEntityType("feature")).toBe("Concept");

			// Process aliases
			expect(service.normalizeEntityType("methodology")).toBe("Process");
			expect(service.normalizeEntityType("workflow")).toBe("Process");

			// Organization aliases
			expect(service.normalizeEntityType("company")).toBe("Organization");
			expect(service.normalizeEntityType("team")).toBe("Organization");

			// Topic aliases
			expect(service.normalizeEntityType("project")).toBe("Topic");
		});

		it("should default to Concept for unknown types", () => {
			expect(service.normalizeEntityType("unknown")).toBe("Concept");
			expect(service.normalizeEntityType("random")).toBe("Concept");
			expect(service.normalizeEntityType("")).toBe("Concept");
			expect(service.normalizeEntityType(null)).toBe("Concept");
			expect(service.normalizeEntityType(undefined)).toBe("Concept");
			expect(service.normalizeEntityType(123)).toBe("Concept");
		});
	});

	describe("buildExtractionPrompt", () => {
		it("should include file path and content", () => {
			const prompt = service.buildExtractionPrompt(
				"/test/doc.md",
				"# Test Document\n\nContent here.",
			);

			expect(prompt).toContain("/test/doc.md");
			expect(prompt).toContain("# Test Document");
			expect(prompt).toContain("Content here.");
		});

		it("should include entity type instructions", () => {
			const prompt = service.buildExtractionPrompt("/test/doc.md", "content");

			expect(prompt).toContain("Topic");
			expect(prompt).toContain("Technology");
			expect(prompt).toContain("Concept");
			expect(prompt).toContain("Tool");
			expect(prompt).toContain("Process");
			expect(prompt).toContain("Person");
			expect(prompt).toContain("Organization");
			expect(prompt).toContain("Document");
		});

		it("should include JSON format instructions", () => {
			const prompt = service.buildExtractionPrompt("/test/doc.md", "content");

			expect(prompt).toContain("entities");
			expect(prompt).toContain("relationships");
			expect(prompt).toContain("summary");
			expect(prompt).toContain("JSON");
		});
	});
});
