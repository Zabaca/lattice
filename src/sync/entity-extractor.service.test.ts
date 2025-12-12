import { beforeEach, describe, expect, it } from "bun:test";
import {
	EntityExtractorService,
	validateExtraction,
} from "./entity-extractor.service.js";

describe("EntityExtractorService", () => {
	let service: EntityExtractorService;

	beforeEach(() => {
		service = new EntityExtractorService();
	});

	describe("validateExtraction", () => {
		it("should pass validation when all relationships reference extracted entities", () => {
			const input = {
				entities: [
					{ name: "TypeScript", type: "Technology" as const, description: "Language" },
					{ name: "NestJS", type: "Technology" as const, description: "Framework" },
				],
				relationships: [
					{ source: "this", relation: "REFERENCES" as const, target: "TypeScript" },
					{ source: "this", relation: "REFERENCES" as const, target: "NestJS" },
				],
				summary: "Test document about TypeScript and NestJS.",
			};

			const errors = validateExtraction(input, "/test/doc.md");
			expect(errors).toHaveLength(0);
		});

		it("should fail when relationship target is not in extracted entities", () => {
			const input = {
				entities: [
					{ name: "TypeScript", type: "Technology" as const, description: "Language" },
				],
				relationships: [
					{ source: "this", relation: "REFERENCES" as const, target: "Unknown" },
				],
				summary: "Test document.",
			};

			const errors = validateExtraction(input, "/test/doc.md");
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("Unknown");
			expect(errors[0]).toContain("not found");
		});

		it("should fail when relationship source is not 'this' and not in entities", () => {
			const input = {
				entities: [
					{ name: "TypeScript", type: "Technology" as const, description: "Language" },
				],
				relationships: [
					{ source: "Unknown", relation: "REFERENCES" as const, target: "TypeScript" },
				],
				summary: "Test document.",
			};

			const errors = validateExtraction(input, "/test/doc.md");
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("Unknown");
			expect(errors[0]).toContain("source");
		});

		it("should allow 'this' as relationship source", () => {
			const input = {
				entities: [
					{ name: "TypeScript", type: "Technology" as const, description: "Language" },
				],
				relationships: [
					{ source: "this", relation: "REFERENCES" as const, target: "TypeScript" },
				],
				summary: "Test document.",
			};

			const errors = validateExtraction(input, "/test/doc.md");
			expect(errors).toHaveLength(0);
		});

		it("should allow entity name as relationship source", () => {
			const input = {
				entities: [
					{ name: "TypeScript", type: "Technology" as const, description: "Language" },
					{ name: "NestJS", type: "Technology" as const, description: "Framework" },
				],
				relationships: [
					{ source: "NestJS", relation: "REFERENCES" as const, target: "TypeScript" },
				],
				summary: "Test document.",
			};

			const errors = validateExtraction(input, "/test/doc.md");
			expect(errors).toHaveLength(0);
		});

		it("should return multiple errors for multiple invalid relationships", () => {
			const input = {
				entities: [
					{ name: "TypeScript", type: "Technology" as const, description: "Language" },
				],
				relationships: [
					{ source: "Invalid1", relation: "REFERENCES" as const, target: "Invalid2" },
					{ source: "this", relation: "REFERENCES" as const, target: "Invalid3" },
				],
				summary: "Test document.",
			};

			const errors = validateExtraction(input, "/test/doc.md");
			expect(errors).toHaveLength(3); // Invalid1 source, Invalid2 target, Invalid3 target
		});

		it("should handle empty entities array", () => {
			const input = {
				entities: [],
				relationships: [],
				summary: "Test document.",
			};

			const errors = validateExtraction(input, "/test/doc.md");
			expect(errors).toHaveLength(0);
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

		it("should include MCP validation tool instructions", () => {
			const prompt = service.buildExtractionPrompt("/test/doc.md", "content");

			expect(prompt).toContain("mcp__entity-validator__validate_extraction");
			expect(prompt).toContain("Validation Required");
		});

		it("should include extraction structure instructions", () => {
			const prompt = service.buildExtractionPrompt("/test/doc.md", "content");

			expect(prompt).toContain("Entities");
			expect(prompt).toContain("Relationships");
			expect(prompt).toContain("Summary");
			expect(prompt).toContain("REFERENCES");
		});
	});
});
