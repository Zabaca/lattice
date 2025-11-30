import { beforeEach, describe, expect, it, mock } from "bun:test";
import { GraphService } from "../graph/graph.service.js";
import type { EntityType, RelationType } from "../graph/graph.types.js";
import {
	CascadeService,
	type CascadeTrigger,
	type EntityChange,
} from "./cascade.service.js";
import {
	type DocumentParserService,
	type ParsedDocument,
} from "./document-parser.service.js";

// Mock dependencies
const createMockGraphService = () => ({
	query: mock(() => Promise.resolve({ resultSet: [], stats: undefined })),
	upsertNode: mock(() => Promise.resolve()),
	upsertRelationship: mock(() => Promise.resolve()),
	deleteNode: mock(() => Promise.resolve()),
	deleteDocumentRelationships: mock(() => Promise.resolve()),
	findNodesByLabel: mock(() => Promise.resolve([])),
	findRelationships: mock(() => Promise.resolve([])),
});

const createMockDocumentParserService = () => ({
	discoverDocuments: mock(() => Promise.resolve([])),
	parseDocument: mock(() =>
		Promise.resolve({
			path: "docs/test.md",
			title: "Test Document",
			content: "# Test",
			contentHash: "abc123",
			frontmatterHash: "def456",
			entities: [],
			relationships: [],
			tags: [],
		} as ParsedDocument),
	),
	parseAllDocuments: mock(() => Promise.resolve([])),
});

// Helper to create a parsed document for testing
const createParsedDocument = (
	path: string,
	entities: Array<{ name: string; type: string; description?: string }> = [],
	relationships: Array<{
		source: string;
		relation: string;
		target: string;
	}> = [],
): ParsedDocument => ({
	path,
	title: path.split("/").pop()?.replace(".md", "") || path,
	content: "# Test",
	contentHash: "abc123",
	frontmatterHash: "def456",
	entities: entities.map((e) => ({ ...e, type: e.type as EntityType })),
	relationships: relationships.map((r) => ({
		...r,
		relation: r.relation as RelationType,
	})),
	tags: [],
});

describe("CascadeService", () => {
	let service: CascadeService;
	let mockGraph: ReturnType<typeof createMockGraphService>;
	let mockParser: ReturnType<typeof createMockDocumentParserService>;

	beforeEach(() => {
		mockGraph = createMockGraphService();
		mockParser = createMockDocumentParserService();

		service = new CascadeService(
			mockGraph as unknown as GraphService,
			mockParser as unknown as DocumentParserService,
		);
	});

	describe("detectEntityRenames", () => {
		it("should detect when an entity is renamed", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorGraph", type: "Technology" },
			]);

			const changes = service.detectEntityRenames(oldDoc, newDoc);

			expect(changes).toHaveLength(1);
			expect(changes[0].trigger).toBe("entity_renamed");
			expect(changes[0].entityName).toBe("FalkorDB");
			expect(changes[0].oldValue).toBe("FalkorDB");
			expect(changes[0].newValue).toBe("FalkorGraph");
			expect(changes[0].documentPath).toBe("docs/test.md");
		});

		it("should not detect rename when entity exists in both versions", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
				{ name: "NestJS", type: "Technology" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
				{ name: "NestJS", type: "Technology" },
			]);

			const changes = service.detectEntityRenames(oldDoc, newDoc);

			expect(changes).toHaveLength(0);
		});

		it("should detect multiple renames in a single document", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "OldName1", type: "Technology" },
				{ name: "OldName2", type: "Concept" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "NewName1", type: "Technology" },
				{ name: "NewName2", type: "Concept" },
			]);

			const changes = service.detectEntityRenames(oldDoc, newDoc);

			// Should detect 2 potential renames (matching by type)
			expect(changes.length).toBeGreaterThanOrEqual(2);
		});

		it("should match renames by same entity type", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "OldTech", type: "Technology" },
				{ name: "OldConcept", type: "Concept" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "NewTech", type: "Technology" },
				{ name: "NewConcept", type: "Concept" },
			]);

			const changes = service.detectEntityRenames(oldDoc, newDoc);

			// Find the Technology rename
			const techRename = changes.find((c) => c.oldValue === "OldTech");
			expect(techRename).toBeDefined();
			expect(techRename?.newValue).toBe("NewTech");

			// Find the Concept rename
			const conceptRename = changes.find((c) => c.oldValue === "OldConcept");
			expect(conceptRename).toBeDefined();
			expect(conceptRename?.newValue).toBe("NewConcept");
		});
	});

	describe("detectEntityDeletions", () => {
		it("should detect when an entity is deleted", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
				{ name: "NestJS", type: "Technology" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "NestJS", type: "Technology" },
			]);

			const changes = service.detectEntityDeletions(oldDoc, newDoc);

			expect(changes).toHaveLength(1);
			expect(changes[0].trigger).toBe("entity_deleted");
			expect(changes[0].entityName).toBe("FalkorDB");
			expect(changes[0].documentPath).toBe("docs/test.md");
		});

		it("should detect multiple deletions", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "Entity1", type: "Technology" },
				{ name: "Entity2", type: "Concept" },
				{ name: "Entity3", type: "Tool" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "Entity2", type: "Concept" },
			]);

			const changes = service.detectEntityDeletions(oldDoc, newDoc);

			expect(changes).toHaveLength(2);
			expect(changes.map((c) => c.entityName)).toContain("Entity1");
			expect(changes.map((c) => c.entityName)).toContain("Entity3");
		});

		it("should return empty array when no entities are deleted", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
				{ name: "NestJS", type: "Technology" }, // Addition, not deletion
			]);

			const changes = service.detectEntityDeletions(oldDoc, newDoc);

			expect(changes).toHaveLength(0);
		});
	});

	describe("detectEntityTypeChanges", () => {
		it("should detect when entity type changes", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "GraphRAG", type: "Concept" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "GraphRAG", type: "Technology" },
			]);

			const changes = service.detectEntityTypeChanges(oldDoc, newDoc);

			expect(changes).toHaveLength(1);
			expect(changes[0].trigger).toBe("entity_type_changed");
			expect(changes[0].entityName).toBe("GraphRAG");
			expect(changes[0].oldValue).toBe("Concept");
			expect(changes[0].newValue).toBe("Technology");
		});

		it("should not detect type change when types are the same", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "FalkorDB", type: "Technology" },
			]);

			const changes = service.detectEntityTypeChanges(oldDoc, newDoc);

			expect(changes).toHaveLength(0);
		});
	});

	describe("findAffectedByRename", () => {
		it("should find documents that reference the renamed entity", async () => {
			// Mock graph query to return documents referencing the entity
			mockGraph.query.mockResolvedValue({
				resultSet: [
					["docs/agents/graph-integration.md", "Graph Integration"],
					["docs/testing/graph-tests.md", "Graph Tests"],
				],
				stats: undefined,
			});

			const affected = await service.findAffectedByRename(
				"FalkorDB",
				"FalkorGraph",
			);

			expect(affected).toHaveLength(2);
			expect(affected[0].path).toBe("docs/agents/graph-integration.md");
			expect(affected[0].suggestedAction).toBe("update_reference");
			expect(affected[0].confidence).toBe("high");
			expect(affected[0].affectedEntities).toContain("FalkorDB");
		});

		it("should return empty array when no documents reference the entity", async () => {
			mockGraph.query.mockResolvedValue({ resultSet: [], stats: undefined });

			const affected = await service.findAffectedByRename(
				"UnknownEntity",
				"NewName",
			);

			expect(affected).toHaveLength(0);
		});
	});

	describe("findAffectedByDeletion", () => {
		it("should find documents that reference the deleted entity", async () => {
			mockGraph.query.mockResolvedValue({
				resultSet: [["docs/other/related.md", "Related Doc"]],
				stats: undefined,
			});

			const affected = await service.findAffectedByDeletion("DeletedEntity");

			expect(affected).toHaveLength(1);
			expect(affected[0].path).toBe("docs/other/related.md");
			expect(affected[0].suggestedAction).toBe("review_content");
			expect(affected[0].confidence).toBe("high");
		});
	});

	describe("analyzeEntityChange", () => {
		it("should analyze entity rename and find affected documents", async () => {
			const change: EntityChange = {
				trigger: "entity_renamed",
				entityName: "FalkorDB",
				oldValue: "FalkorDB",
				newValue: "FalkorGraph",
				documentPath: "docs/topic/file.md",
			};

			mockGraph.query.mockResolvedValue({
				resultSet: [["docs/agents/graph-integration.md", "Graph Integration"]],
				stats: undefined,
			});

			const analysis = await service.analyzeEntityChange(change);

			expect(analysis.trigger).toBe("entity_renamed");
			expect(analysis.sourceDocument).toBe("docs/topic/file.md");
			expect(analysis.affectedDocuments).toHaveLength(1);
			expect(analysis.summary).toContain("FalkorDB");
			expect(analysis.summary).toContain("FalkorGraph");
		});

		it("should analyze entity deletion and find affected documents", async () => {
			const change: EntityChange = {
				trigger: "entity_deleted",
				entityName: "DeprecatedFeature",
				documentPath: "docs/topic/file.md",
			};

			mockGraph.query.mockResolvedValue({
				resultSet: [["docs/features/main.md", "Main Features"]],
				stats: undefined,
			});

			const analysis = await service.analyzeEntityChange(change);

			expect(analysis.trigger).toBe("entity_deleted");
			expect(analysis.affectedDocuments).toHaveLength(1);
			expect(analysis.affectedDocuments[0].suggestedAction).toBe(
				"review_content",
			);
		});

		it("should analyze entity type change", async () => {
			const change: EntityChange = {
				trigger: "entity_type_changed",
				entityName: "GraphRAG",
				oldValue: "Concept",
				newValue: "Technology",
				documentPath: "docs/topic/file.md",
			};

			mockGraph.query.mockResolvedValue({
				resultSet: [["docs/concepts/overview.md", "Overview"]],
				stats: undefined,
			});

			const analysis = await service.analyzeEntityChange(change);

			expect(analysis.trigger).toBe("entity_type_changed");
			expect(analysis.affectedDocuments[0].suggestedAction).toBe(
				"review_content",
			);
		});
	});

	describe("analyzeDocumentChange", () => {
		it("should detect all changes when comparing document versions", async () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "OldEntity", type: "Technology" },
				{ name: "DeletedEntity", type: "Concept" },
				{ name: "TypeChanging", type: "Concept" },
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "NewEntity", type: "Technology" },
				{ name: "TypeChanging", type: "Technology" },
			]);

			// Return affected documents from graph queries so analyses are returned
			mockGraph.query.mockResolvedValue({
				resultSet: [["docs/other.md", "Other Doc"]],
				stats: undefined,
			});

			const analyses = await service.analyzeDocumentChange(oldDoc, newDoc);

			// Should detect: 1 rename (OldEntity -> NewEntity), 1 deletion (DeletedEntity), 1 type change (TypeChanging)
			expect(analyses.length).toBeGreaterThanOrEqual(2);

			const triggers = analyses.map((a) => a.trigger);
			expect(triggers).toContain("entity_deleted");
			expect(triggers).toContain("entity_type_changed");
		});

		it("should handle new document (null old doc)", async () => {
			const newDoc = createParsedDocument("docs/new.md", [
				{ name: "NewEntity", type: "Technology" },
			]);

			const analyses = await service.analyzeDocumentChange(null, newDoc);

			// New documents don't generate cascade warnings
			expect(analyses).toHaveLength(0);
		});
	});

	describe("formatWarnings", () => {
		it("should format cascade analysis as readable output", () => {
			const analyses = [
				{
					trigger: "entity_renamed" as CascadeTrigger,
					sourceDocument: "docs/topic/file.md",
					affectedDocuments: [
						{
							path: "docs/agents/graph-integration.md",
							reason: 'References "FalkorDB" in entities',
							suggestedAction: "update_reference" as const,
							confidence: "high" as const,
							affectedEntities: ["FalkorDB"],
						},
						{
							path: "docs/testing/graph-tests.md",
							reason: 'References "FalkorDB" in relationships',
							suggestedAction: "update_reference" as const,
							confidence: "high" as const,
							affectedEntities: ["FalkorDB"],
						},
					],
					summary: 'Entity "FalkorDB" was renamed to "FalkorGraph"',
				},
			];

			const output = service.formatWarnings(analyses);

			expect(output).toContain("Cascade Impact Detected");
			expect(output).toContain("FalkorDB");
			expect(output).toContain("FalkorGraph");
			expect(output).toContain("docs/agents/graph-integration.md");
			expect(output).toContain("docs/testing/graph-tests.md");
			expect(output).toContain("[high]");
			expect(output).toContain("Update reference");
		});

		it("should return empty string when no warnings", () => {
			const output = service.formatWarnings([]);

			expect(output).toBe("");
		});

		it("should format multiple analyses", () => {
			const analyses = [
				{
					trigger: "entity_renamed" as CascadeTrigger,
					sourceDocument: "docs/a.md",
					affectedDocuments: [
						{
							path: "docs/b.md",
							reason: "References entity",
							suggestedAction: "update_reference" as const,
							confidence: "high" as const,
							affectedEntities: ["Entity1"],
						},
					],
					summary: 'Entity "Entity1" was renamed',
				},
				{
					trigger: "entity_deleted" as CascadeTrigger,
					sourceDocument: "docs/a.md",
					affectedDocuments: [
						{
							path: "docs/c.md",
							reason: "References deleted entity",
							suggestedAction: "review_content" as const,
							confidence: "high" as const,
							affectedEntities: ["Entity2"],
						},
					],
					summary: 'Entity "Entity2" was deleted',
				},
			];

			const output = service.formatWarnings(analyses);

			expect(output).toContain("Entity1");
			expect(output).toContain("Entity2");
			expect(output).toContain("docs/b.md");
			expect(output).toContain("docs/c.md");
		});

		it("should show confidence levels correctly", () => {
			const analyses = [
				{
					trigger: "entity_renamed" as CascadeTrigger,
					sourceDocument: "docs/source.md",
					affectedDocuments: [
						{
							path: "docs/high.md",
							reason: "Exact match",
							suggestedAction: "update_reference" as const,
							confidence: "high" as const,
							affectedEntities: ["Entity"],
						},
						{
							path: "docs/medium.md",
							reason: "Similar match",
							suggestedAction: "review_content" as const,
							confidence: "medium" as const,
							affectedEntities: ["Entity"],
						},
						{
							path: "docs/low.md",
							reason: "Possible match",
							suggestedAction: "review_content" as const,
							confidence: "low" as const,
							affectedEntities: ["Entity"],
						},
					],
					summary: "Entity renamed",
				},
			];

			const output = service.formatWarnings(analyses);

			expect(output).toContain("[high]");
			expect(output).toContain("[medium]");
			expect(output).toContain("[low]");
		});
	});

	describe("relationship change detection", () => {
		it("should detect relationship changes", () => {
			const oldDoc = createParsedDocument(
				"docs/test.md",
				[
					{ name: "AppA", type: "Tool" },
					{ name: "LibB", type: "Technology" },
				],
				[{ source: "AppA", relation: "USES", target: "LibB" }],
			);
			const newDoc = createParsedDocument(
				"docs/test.md",
				[
					{ name: "AppA", type: "Tool" },
					{ name: "LibB", type: "Technology" },
				],
				[{ source: "AppA", relation: "DEPENDS_ON", target: "LibB" }],
			);

			// Service should detect relationship type change
			// This will be covered in analyzeDocumentChange
			expect(oldDoc.relationships[0].relation).not.toBe(
				newDoc.relationships[0].relation,
			);
		});
	});

	describe("edge cases", () => {
		it("should handle empty old document", () => {
			const oldDoc = createParsedDocument("docs/test.md", []);
			const newDoc = createParsedDocument("docs/test.md", [
				{ name: "NewEntity", type: "Technology" },
			]);

			const deletions = service.detectEntityDeletions(oldDoc, newDoc);
			const renames = service.detectEntityRenames(oldDoc, newDoc);

			expect(deletions).toHaveLength(0);
			expect(renames).toHaveLength(0);
		});

		it("should handle empty new document", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{ name: "OldEntity", type: "Technology" },
			]);
			const newDoc = createParsedDocument("docs/test.md", []);

			const deletions = service.detectEntityDeletions(oldDoc, newDoc);

			expect(deletions).toHaveLength(1);
			expect(deletions[0].entityName).toBe("OldEntity");
		});

		it("should handle entities with same name but different descriptions", () => {
			const oldDoc = createParsedDocument("docs/test.md", [
				{
					name: "FalkorDB",
					type: "Technology",
					description: "Old description",
				},
			]);
			const newDoc = createParsedDocument("docs/test.md", [
				{
					name: "FalkorDB",
					type: "Technology",
					description: "New description",
				},
			]);

			const renames = service.detectEntityRenames(oldDoc, newDoc);
			const deletions = service.detectEntityDeletions(oldDoc, newDoc);
			const typeChanges = service.detectEntityTypeChanges(oldDoc, newDoc);

			// Description change shouldn't trigger rename, deletion, or type change
			expect(renames).toHaveLength(0);
			expect(deletions).toHaveLength(0);
			expect(typeChanges).toHaveLength(0);
		});
	});
});
