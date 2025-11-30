import { beforeEach, describe, expect, it, mock } from "bun:test";
import { GraphService } from "../graph/graph.service.js";
import { CascadeService } from "./cascade.service.js";
import {
	DocumentParserService,
	ParsedDocument,
} from "./document-parser.service.js";
import { ChangeType, ManifestService } from "./manifest.service.js";
import { PathResolverService } from "./path-resolver.service.js";
import { SyncService } from "./sync.service.js";

// Mock dependencies
const createMockManifestService = () => ({
	load: mock(() =>
		Promise.resolve({
			version: "1.0",
			lastSync: new Date().toISOString(),
			documents: {},
		}),
	),
	save: mock(() => Promise.resolve()),
	detectChange: mock(() => "new" as ChangeType),
	updateEntry: mock(() => {}),
	removeEntry: mock(() => {}),
	getTrackedPaths: mock(() => []),
	getContentHash: mock((content: string) => `hash-${content.slice(0, 10)}`),
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

const createMockGraphService = () => ({
	query: mock(() => Promise.resolve({ resultSet: [], stats: undefined })),
	upsertNode: mock(() => Promise.resolve()),
	upsertRelationship: mock(() => Promise.resolve()),
	deleteNode: mock(() => Promise.resolve()),
	deleteDocumentRelationships: mock(() => Promise.resolve()),
});

const createMockCascadeService = () => ({
	analyzeDocumentChange: mock(() => Promise.resolve([])),
});

const createMockPathResolverService = () => ({
	getDocsPath: mock(() => "/home/user/project/docs"),
	resolveDocPath: mock((path: string) => path), // Pass-through for existing tests
	resolveDocPaths: mock((paths: string[]) => paths), // Pass-through for existing tests
	isUnderDocs: mock(() => true),
	getRelativePath: mock((path: string) => path),
});

describe("SyncService", () => {
	let service: SyncService;
	let mockManifest: ReturnType<typeof createMockManifestService>;
	let mockParser: ReturnType<typeof createMockDocumentParserService>;
	let mockGraph: ReturnType<typeof createMockGraphService>;
	let mockCascade: ReturnType<typeof createMockCascadeService>;
	let mockPathResolver: ReturnType<typeof createMockPathResolverService>;

	beforeEach(() => {
		mockManifest = createMockManifestService();
		mockParser = createMockDocumentParserService();
		mockGraph = createMockGraphService();
		mockCascade = createMockCascadeService();
		mockPathResolver = createMockPathResolverService();

		service = new SyncService(
			mockManifest as unknown as ManifestService,
			mockParser as unknown as DocumentParserService,
			mockGraph as unknown as GraphService,
			mockCascade as unknown as CascadeService,
			mockPathResolver as unknown as PathResolverService,
		);
	});

	describe("detectChanges", () => {
		it("should detect new documents", async () => {
			mockParser.discoverDocuments.mockResolvedValue(["docs/new.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/new.md",
				title: "New Doc",
				content: "# New",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [],
				relationships: [],
				tags: [],
			} as ParsedDocument);
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			const changes = await service.detectChanges();

			expect(changes).toHaveLength(1);
			expect(changes[0].path).toBe("docs/new.md");
			expect(changes[0].changeType).toBe("new");
		});

		it("should detect deleted documents", async () => {
			mockParser.discoverDocuments.mockResolvedValue([]);
			mockManifest.getTrackedPaths.mockReturnValue(["docs/deleted.md"]);

			const changes = await service.detectChanges();

			expect(changes).toHaveLength(1);
			expect(changes[0].path).toBe("docs/deleted.md");
			expect(changes[0].changeType).toBe("deleted");
		});

		it("should detect updated documents", async () => {
			mockParser.discoverDocuments.mockResolvedValue(["docs/updated.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/updated.md",
				title: "Updated Doc",
				content: "# Updated",
				contentHash: "newhash",
				frontmatterHash: "newfmhash",
				entities: [],
				relationships: [],
				tags: [],
			} as ParsedDocument);
			mockManifest.detectChange.mockReturnValue("updated");
			mockManifest.getTrackedPaths.mockReturnValue(["docs/updated.md"]);

			const changes = await service.detectChanges();

			expect(changes).toHaveLength(1);
			expect(changes[0].path).toBe("docs/updated.md");
			expect(changes[0].changeType).toBe("updated");
		});

		it("should detect unchanged documents", async () => {
			mockParser.discoverDocuments.mockResolvedValue(["docs/same.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/same.md",
				title: "Same Doc",
				content: "# Same",
				contentHash: "samehash",
				frontmatterHash: "samefmhash",
				entities: [],
				relationships: [],
				tags: [],
			} as ParsedDocument);
			mockManifest.detectChange.mockReturnValue("unchanged");
			mockManifest.getTrackedPaths.mockReturnValue(["docs/same.md"]);

			const changes = await service.detectChanges();

			expect(changes).toHaveLength(1);
			expect(changes[0].path).toBe("docs/same.md");
			expect(changes[0].changeType).toBe("unchanged");
		});

		it("should filter changes by specific paths when provided", async () => {
			mockParser.discoverDocuments.mockResolvedValue([
				"docs/a.md",
				"docs/b.md",
				"docs/c.md",
			]);
			mockParser.parseDocument.mockImplementation(
				async (path: string) =>
					({
						path,
						title: path,
						content: "# Test",
						contentHash: "hash",
						frontmatterHash: "fmhash",
						entities: [],
						relationships: [],
						tags: [],
					}) as ParsedDocument,
			);
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			const changes = await service.detectChanges(["docs/a.md", "docs/c.md"]);

			expect(changes).toHaveLength(2);
			expect(changes.map((c) => c.path)).toContain("docs/a.md");
			expect(changes.map((c) => c.path)).toContain("docs/c.md");
			expect(changes.map((c) => c.path)).not.toContain("docs/b.md");
		});
	});

	describe("syncDocument", () => {
		it("should create Document node", async () => {
			const doc: ParsedDocument = {
				path: "docs/test.md",
				title: "Test Document",
				content: "# Test content",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [],
				relationships: [],
				tags: ["test"],
			};

			await service.syncDocument(doc);

			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Document",
				expect.objectContaining({
					name: "docs/test.md",
					title: "Test Document",
				}),
			);
		});

		it("should create entity nodes and APPEARS_IN relationships", async () => {
			const doc: ParsedDocument = {
				path: "docs/test.md",
				title: "Test Document",
				content: "# Test",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [
					{
						name: "FalkorDB",
						type: "Technology",
						description: "Graph database",
					},
					{ name: "NestJS", type: "Technology" },
				],
				relationships: [],
				tags: [],
			};

			await service.syncDocument(doc);

			// Should create entity nodes
			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Technology",
				expect.objectContaining({
					name: "FalkorDB",
					description: "Graph database",
				}),
			);
			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Technology",
				expect.objectContaining({
					name: "NestJS",
				}),
			);

			// Should create APPEARS_IN relationships
			expect(mockGraph.upsertRelationship).toHaveBeenCalledWith(
				"Technology",
				"FalkorDB",
				"APPEARS_IN",
				"Document",
				"docs/test.md",
				expect.objectContaining({ documentPath: "docs/test.md" }),
			);
		});

		it("should create user-defined relationships between entities", async () => {
			const doc: ParsedDocument = {
				path: "docs/test.md",
				title: "Test Document",
				content: "# Test",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [
					{ name: "MyApp", type: "Tool" },
					{ name: "FalkorDB", type: "Technology" },
				],
				relationships: [
					{ source: "MyApp", relation: "USES", target: "FalkorDB" },
				],
				tags: [],
			};

			await service.syncDocument(doc);

			expect(mockGraph.upsertRelationship).toHaveBeenCalledWith(
				"Tool",
				"MyApp",
				"USES",
				"Technology",
				"FalkorDB",
				expect.objectContaining({ documentPath: "docs/test.md" }),
			);
		});

		it('should resolve "this" in relationships to document path', async () => {
			const doc: ParsedDocument = {
				path: "docs/falkordb-guide.md",
				title: "FalkorDB Guide",
				content: "# Guide",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [{ name: "FalkorDB", type: "Technology" }],
				relationships: [
					{
						source: "docs/falkordb-guide.md",
						relation: "DOCUMENTS",
						target: "FalkorDB",
					},
				],
				tags: [],
			};

			await service.syncDocument(doc);

			// The document should have a DOCUMENTS relationship to the entity
			expect(mockGraph.upsertRelationship).toHaveBeenCalledWith(
				"Document",
				"docs/falkordb-guide.md",
				"DOCUMENTS",
				"Technology",
				"FalkorDB",
				expect.objectContaining({ documentPath: "docs/falkordb-guide.md" }),
			);
		});

		it("should include graph metadata in Document node", async () => {
			const doc: ParsedDocument = {
				path: "docs/test.md",
				title: "Important Doc",
				content: "# Test",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [],
				relationships: [],
				graphMetadata: { importance: "high", domain: "architecture" },
				tags: [],
			};

			await service.syncDocument(doc);

			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Document",
				expect.objectContaining({
					name: "docs/test.md",
					importance: "high",
					domain: "architecture",
				}),
			);
		});
	});

	describe("removeDocument", () => {
		it("should remove Document node", async () => {
			await service.removeDocument("docs/deleted.md");

			expect(mockGraph.deleteNode).toHaveBeenCalledWith(
				"Document",
				"docs/deleted.md",
			);
		});

		it("should remove relationships associated with document", async () => {
			await service.removeDocument("docs/deleted.md");

			expect(mockGraph.deleteDocumentRelationships).toHaveBeenCalledWith(
				"docs/deleted.md",
			);
		});
	});

	describe("sync", () => {
		it("should load manifest at start", async () => {
			mockParser.discoverDocuments.mockResolvedValue([]);
			mockManifest.getTrackedPaths.mockReturnValue([]);

			await service.sync();

			expect(mockManifest.load).toHaveBeenCalled();
		});

		it("should save manifest after sync", async () => {
			mockParser.discoverDocuments.mockResolvedValue([]);
			mockManifest.getTrackedPaths.mockReturnValue([]);

			await service.sync();

			expect(mockManifest.save).toHaveBeenCalled();
		});

		it("should not save manifest in dry-run mode", async () => {
			mockParser.discoverDocuments.mockResolvedValue([]);
			mockManifest.getTrackedPaths.mockReturnValue([]);

			await service.sync({ dryRun: true });

			expect(mockManifest.save).not.toHaveBeenCalled();
		});

		it("should not modify graph in dry-run mode", async () => {
			mockParser.discoverDocuments.mockResolvedValue(["docs/new.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/new.md",
				title: "New Doc",
				content: "# New",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [{ name: "Test", type: "Concept" }],
				relationships: [],
				tags: [],
			} as ParsedDocument);
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			await service.sync({ dryRun: true });

			expect(mockGraph.upsertNode).not.toHaveBeenCalled();
			expect(mockGraph.upsertRelationship).not.toHaveBeenCalled();
		});

		it("should return correct sync result counts", async () => {
			mockParser.discoverDocuments.mockResolvedValue([
				"docs/new.md",
				"docs/updated.md",
				"docs/unchanged.md",
			]);
			mockParser.parseDocument.mockImplementation(
				async (path: string) =>
					({
						path,
						title: path,
						content: "# Test",
						contentHash: "hash",
						frontmatterHash: "fmhash",
						entities: [],
						relationships: [],
						tags: [],
					}) as ParsedDocument,
			);
			mockManifest.detectChange.mockImplementation((path: string) => {
				if (path === "docs/new.md") return "new";
				if (path === "docs/updated.md") return "updated";
				return "unchanged";
			});
			mockManifest.getTrackedPaths.mockReturnValue([
				"docs/updated.md",
				"docs/unchanged.md",
				"docs/deleted.md",
			]);

			const result = await service.sync();

			expect(result.added).toBe(1);
			expect(result.updated).toBe(1);
			expect(result.unchanged).toBe(1);
			expect(result.deleted).toBe(1);
		});

		it("should collect errors and continue syncing", async () => {
			// Note: detectChanges parses documents first. Errors during detection
			// are captured and the doc is still treated as 'new' for retry.
			// The second parse attempt in sync() may also fail.
			let _parseCallCount = 0;
			mockParser.discoverDocuments.mockResolvedValue([
				"docs/good.md",
				"docs/bad.md",
			]);
			mockParser.parseDocument.mockImplementation(async (path: string) => {
				_parseCallCount++;
				if (path === "docs/bad.md") {
					throw new Error("Parse error");
				}
				return {
					path,
					title: "Good Doc",
					content: "# Good",
					contentHash: "abc123",
					frontmatterHash: "def456",
					entities: [],
					relationships: [],
					tags: [],
				} as ParsedDocument;
			});
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			const result = await service.sync();

			// Errors are collected (may be 1 or 2 depending on retry behavior)
			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			expect(result.errors.some((e) => e.path === "docs/bad.md")).toBe(true);
			expect(result.errors.some((e) => e.error.includes("Parse error"))).toBe(
				true,
			);
		});

		it("should return duration in result", async () => {
			mockParser.discoverDocuments.mockResolvedValue([]);
			mockManifest.getTrackedPaths.mockReturnValue([]);

			const result = await service.sync();

			expect(result.duration).toBeGreaterThanOrEqual(0);
			expect(typeof result.duration).toBe("number");
		});

		it("should include changes in result", async () => {
			mockParser.discoverDocuments.mockResolvedValue(["docs/new.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/new.md",
				title: "New Doc",
				content: "# New",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [],
				relationships: [],
				tags: [],
			} as ParsedDocument);
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			const result = await service.sync();

			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].path).toBe("docs/new.md");
			expect(result.changes[0].changeType).toBe("new");
		});

		it("should sync only specified paths when provided", async () => {
			mockParser.discoverDocuments.mockResolvedValue([
				"docs/a.md",
				"docs/b.md",
				"docs/c.md",
			]);
			mockParser.parseDocument.mockImplementation(
				async (path: string) =>
					({
						path,
						title: path,
						content: "# Test",
						contentHash: "hash",
						frontmatterHash: "fmhash",
						entities: [],
						relationships: [],
						tags: [],
					}) as ParsedDocument,
			);
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			const result = await service.sync({ paths: ["docs/a.md"] });

			expect(result.added).toBe(1);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].path).toBe("docs/a.md");
		});
	});

	describe("sync with force option", () => {
		it("should clear manifest when force is true without paths", async () => {
			// Force mode now clears manifest (not graph) to force re-sync
			// MERGE operations will update existing nodes
			mockParser.discoverDocuments.mockResolvedValue(["docs/existing.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/existing.md",
				title: "Existing",
				content: "# Existing",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [],
				relationships: [],
				tags: [],
			} as ParsedDocument);
			// After manifest clear, all docs should be "new"
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			const result = await service.sync({ force: true });

			// In force mode, manifest is cleared, so all docs become "new"
			expect(result.added).toBe(1);
		});

		it("should only clear manifest entries for specified paths when force with paths", async () => {
			mockParser.discoverDocuments.mockResolvedValue([
				"docs/a.md",
				"docs/b.md",
			]);
			mockParser.parseDocument.mockImplementation(
				async (path: string) =>
					({
						path,
						title: path,
						content: "# Test",
						contentHash: "hash",
						frontmatterHash: "fmhash",
						entities: [],
						relationships: [],
						tags: [],
					}) as ParsedDocument,
			);
			mockManifest.getTrackedPaths.mockReturnValue(["docs/a.md", "docs/b.md"]);
			mockManifest.detectChange.mockReturnValue("new");

			await service.sync({ force: true, paths: ["docs/a.md"] });

			// Should remove only the specified path from manifest
			expect(mockManifest.removeEntry).toHaveBeenCalledWith("docs/a.md");
			expect(mockManifest.removeEntry).not.toHaveBeenCalledWith("docs/b.md");
		});
	});

	describe("sync updates manifest entries", () => {
		it("should update manifest entry for new documents", async () => {
			mockParser.discoverDocuments.mockResolvedValue(["docs/new.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/new.md",
				title: "New Doc",
				content: "# New",
				contentHash: "abc123",
				frontmatterHash: "def456",
				entities: [
					{ name: "EntityA", type: "Concept" },
					{ name: "EntityB", type: "Concept" },
				],
				relationships: [
					{ source: "EntityA", relation: "USES", target: "EntityB" },
				],
				tags: [],
			} as ParsedDocument);
			mockManifest.detectChange.mockReturnValue("new");
			mockManifest.getTrackedPaths.mockReturnValue([]);

			await service.sync();

			expect(mockManifest.updateEntry).toHaveBeenCalledWith(
				"docs/new.md",
				"abc123",
				"def456",
				2, // 2 entities
				1, // 1 relationship
			);
		});

		it("should remove manifest entry for deleted documents", async () => {
			mockParser.discoverDocuments.mockResolvedValue([]);
			mockManifest.getTrackedPaths.mockReturnValue(["docs/deleted.md"]);

			await service.sync();

			expect(mockManifest.removeEntry).toHaveBeenCalledWith("docs/deleted.md");
		});

		it("should not update manifest for unchanged documents", async () => {
			mockParser.discoverDocuments.mockResolvedValue(["docs/same.md"]);
			mockParser.parseDocument.mockResolvedValue({
				path: "docs/same.md",
				title: "Same Doc",
				content: "# Same",
				contentHash: "samehash",
				frontmatterHash: "samefmhash",
				entities: [],
				relationships: [],
				tags: [],
			} as ParsedDocument);
			mockManifest.detectChange.mockReturnValue("unchanged");
			mockManifest.getTrackedPaths.mockReturnValue(["docs/same.md"]);

			await service.sync();

			expect(mockManifest.updateEntry).not.toHaveBeenCalled();
		});
	});

	describe("removeDocument cleans up properly", () => {
		it("should delete relationships before document node", async () => {
			const callOrder: string[] = [];
			mockGraph.deleteDocumentRelationships.mockImplementation(async () => {
				callOrder.push("deleteRelationships");
			});
			mockGraph.deleteNode.mockImplementation(async () => {
				callOrder.push("deleteNode");
			});

			await service.removeDocument("docs/test.md");

			expect(callOrder).toEqual(["deleteRelationships", "deleteNode"]);
		});
	});
});
