import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ParsedDocument } from "./document-parser.service.js";
import { SyncService } from "./sync.service.js";

// Helper to create a valid ParsedDocument for tests
const createDoc = (
	overrides: Partial<ParsedDocument> = {},
): ParsedDocument => ({
	path: "docs/test.md",
	title: "Test Document",
	summary: "Test document summary",
	created: new Date("2024-01-01"),
	updated: new Date("2024-01-01"),
	status: "active",
	content: "# Test",
	contentHash: "abc123",
	frontmatterHash: "def456",
	entities: [],
	relationships: [],
	tags: [],
	...overrides,
});

// biome-ignore lint/suspicious/noExplicitAny: Mock objects are intentionally loosely typed for flexibility
type MockService = any;

describe("SyncService", () => {
	let service: SyncService;
	let mockManifest: MockService;
	let mockParser: MockService;
	let mockGraph: MockService;
	let mockCascade: MockService;
	let mockPathResolver: MockService;

	beforeEach(() => {
		mockManifest = {
			load: mock(() =>
				Promise.resolve({
					version: "1.0",
					lastSync: new Date().toISOString(),
					documents: {},
				}),
			),
			save: mock(() => Promise.resolve()),
			detectChange: mock(() => "new"),
			getTrackedPaths: mock(() => []),
			updateEntry: mock(() => {}),
			removeEntry: mock(() => {}),
			clear: mock(() => {}),
		};

		mockParser = {
			discoverDocuments: mock(() => Promise.resolve([])),
			parseDocument: mock(() => Promise.resolve(createDoc())),
		};

		mockGraph = {
			query: mock(() => Promise.resolve({ resultSet: [], stats: undefined })),
			upsertNode: mock(() => Promise.resolve()),
			upsertRelationship: mock(() => Promise.resolve()),
			deleteNode: mock(() => Promise.resolve()),
			deleteDocumentRelationships: mock(() => Promise.resolve()),
			checkpoint: mock(() => Promise.resolve()),
		};

		mockCascade = {
			analyzeDocumentChange: mock(() => Promise.resolve([])),
		};

		mockPathResolver = {
			getDocsPath: mock(() => "/home/user/project/docs"),
			resolveDocPaths: mock((paths: string[]) => paths),
			isUnderDocs: mock(() => true),
		};

		service = new SyncService(
			mockManifest,
			mockParser,
			mockGraph,
			mockCascade,
			mockPathResolver,
		);
	});

	describe("detectChanges", () => {
		it("returns new documents not in manifest", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/new.md"]),
			);
			mockParser.parseDocument.mockImplementation(() =>
				Promise.resolve(createDoc({ path: "docs/new.md" })),
			);

			const changes = await service.detectChanges();

			expect(changes).toHaveLength(1);
			expect(changes[0].path).toBe("docs/new.md");
			expect(changes[0].changeType).toBe("new");
		});

		it("returns deleted documents no longer on disk", async () => {
			mockManifest.getTrackedPaths.mockImplementation(() => [
				"docs/deleted.md",
			]);

			const changes = await service.detectChanges();

			expect(changes).toHaveLength(1);
			expect(changes[0].path).toBe("docs/deleted.md");
			expect(changes[0].changeType).toBe("deleted");
		});

		it("returns updated documents with changed content", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/updated.md"]),
			);
			mockParser.parseDocument.mockImplementation(() =>
				Promise.resolve(createDoc({ path: "docs/updated.md" })),
			);
			mockManifest.detectChange.mockImplementation(() => "updated");
			mockManifest.getTrackedPaths.mockImplementation(() => [
				"docs/updated.md",
			]);

			const changes = await service.detectChanges();

			expect(changes).toHaveLength(1);
			expect(changes[0].path).toBe("docs/updated.md");
			expect(changes[0].changeType).toBe("updated");
		});

		it("filters to specific paths when provided", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/a.md", "docs/b.md", "docs/c.md"]),
			);
			mockParser.parseDocument.mockImplementation((path: string) =>
				Promise.resolve(createDoc({ path })),
			);

			const changes = await service.detectChanges(["docs/a.md", "docs/c.md"]);

			expect(changes).toHaveLength(2);
			expect(changes.map((c) => c.path)).toContain("docs/a.md");
			expect(changes.map((c) => c.path)).toContain("docs/c.md");
			expect(changes.map((c) => c.path)).not.toContain("docs/b.md");
		});
	});

	describe("syncDocument", () => {
		it("creates Document node in graph", async () => {
			const doc = createDoc({ tags: ["test"] });

			await service.syncDocument(doc);

			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Document",
				expect.objectContaining({
					name: "docs/test.md",
					title: "Test Document",
				}),
			);
		});

		it("creates entity nodes and APPEARS_IN relationships", async () => {
			const doc = createDoc({
				entities: [
					{
						name: "FalkorDB",
						type: "Technology",
						description: "Graph database",
					},
					{ name: "NestJS", type: "Technology" },
				],
			});

			await service.syncDocument(doc);

			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Technology",
				expect.objectContaining({
					name: "FalkorDB",
					description: "Graph database",
				}),
			);
			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Technology",
				expect.objectContaining({ name: "NestJS" }),
			);

			expect(mockGraph.upsertRelationship).toHaveBeenCalledWith(
				"Technology",
				"FalkorDB",
				"APPEARS_IN",
				"Document",
				"docs/test.md",
				expect.objectContaining({ documentPath: "docs/test.md" }),
			);
		});

		it("creates user-defined relationships between entities", async () => {
			const doc = createDoc({
				entities: [
					{ name: "MyApp", type: "Tool" },
					{ name: "FalkorDB", type: "Technology" },
				],
				relationships: [
					{ source: "MyApp", relation: "REFERENCES", target: "FalkorDB" },
				],
			});

			await service.syncDocument(doc);

			expect(mockGraph.upsertRelationship).toHaveBeenCalledWith(
				"Tool",
				"MyApp",
				"REFERENCES",
				"Technology",
				"FalkorDB",
				expect.objectContaining({ documentPath: "docs/test.md" }),
			);
		});

		it("includes graph metadata in Document node", async () => {
			const doc = createDoc({
				graphMetadata: { importance: "high", domain: "architecture" },
			});

			await service.syncDocument(doc);

			expect(mockGraph.upsertNode).toHaveBeenCalledWith(
				"Document",
				expect.objectContaining({
					importance: "high",
					domain: "architecture",
				}),
			);
		});
	});

	describe("removeDocument", () => {
		it("removes Document node from graph", async () => {
			await service.removeDocument("docs/deleted.md");

			expect(mockGraph.deleteNode).toHaveBeenCalledWith(
				"Document",
				"docs/deleted.md",
			);
		});

		it("removes relationships associated with document", async () => {
			await service.removeDocument("docs/deleted.md");

			expect(mockGraph.deleteDocumentRelationships).toHaveBeenCalledWith(
				"docs/deleted.md",
			);
		});
	});

	describe("sync", () => {
		it("returns correct counts for mixed changes", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve([
					"docs/new.md",
					"docs/updated.md",
					"docs/unchanged.md",
				]),
			);
			mockParser.parseDocument.mockImplementation((path: string) =>
				Promise.resolve(createDoc({ path })),
			);
			mockManifest.detectChange.mockImplementation((path: string) => {
				if (path === "docs/new.md") return "new";
				if (path === "docs/updated.md") return "updated";
				return "unchanged";
			});
			mockManifest.getTrackedPaths.mockImplementation(() => [
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

		it("does not modify graph in dry-run mode", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/new.md"]),
			);
			mockParser.parseDocument.mockImplementation(() =>
				Promise.resolve(
					createDoc({
						path: "docs/new.md",
						entities: [{ name: "Test", type: "Concept" }],
					}),
				),
			);

			await service.sync({ dryRun: true });

			expect(mockGraph.upsertNode).not.toHaveBeenCalled();
			expect(mockGraph.upsertRelationship).not.toHaveBeenCalled();
		});

		it("collects errors and continues syncing other documents", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/good.md", "docs/bad.md"]),
			);
			mockParser.parseDocument.mockImplementation((path: string) => {
				if (path === "docs/bad.md") {
					return Promise.reject(new Error("Parse error"));
				}
				return Promise.resolve(createDoc({ path }));
			});

			const result = await service.sync();

			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			expect(result.errors.some((e) => e.path === "docs/bad.md")).toBe(true);
			expect(result.errors.some((e) => e.error.includes("Parse error"))).toBe(
				true,
			);
		});

		it("returns duration in result", async () => {
			const result = await service.sync();

			expect(result.duration).toBeGreaterThanOrEqual(0);
			expect(typeof result.duration).toBe("number");
		});

		it("includes changes in result", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/new.md"]),
			);
			mockParser.parseDocument.mockImplementation(() =>
				Promise.resolve(createDoc({ path: "docs/new.md" })),
			);

			const result = await service.sync();

			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].path).toBe("docs/new.md");
			expect(result.changes[0].changeType).toBe("new");
		});

		it("syncs only specified paths when provided", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/a.md", "docs/b.md", "docs/c.md"]),
			);
			mockParser.parseDocument.mockImplementation(() =>
				Promise.resolve(createDoc({ path: "docs/a.md" })),
			);

			const result = await service.sync({ paths: ["docs/a.md"] });

			expect(result.added).toBe(1);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].path).toBe("docs/a.md");
		});

		it("treats all documents as new in force mode", async () => {
			mockParser.discoverDocuments.mockImplementation(() =>
				Promise.resolve(["docs/existing.md"]),
			);
			mockParser.parseDocument.mockImplementation(() =>
				Promise.resolve(createDoc({ path: "docs/existing.md" })),
			);

			const result = await service.sync({ force: true });

			expect(result.added).toBe(1);
		});
	});
});
