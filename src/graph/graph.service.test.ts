import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";

// Increase timeout for tests that load DuckPGQ extension from remote
setDefaultTimeout(15000);

import { existsSync, rmSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import { getDatabasePath, setLatticeHomeForTesting } from "../utils/paths.js";
import { GraphService } from "./graph.service.js";

// Use a temp directory for tests to avoid conflicts with user data
const TEST_HOME = "/tmp/lattice-test";

class TestConfigService {
	private config: Record<string, unknown>;

	constructor(overrides: Record<string, unknown> = {}) {
		this.config = {
			...overrides,
		};
	}

	get<T>(key: string, defaultValue?: T): T {
		return (this.config[key] as T) ?? (defaultValue as T);
	}
}

/**
 * @fileoverview Integration tests for GraphService with DuckDB
 *
 * These tests use a real DuckDB instance. Connection is established ONCE
 * in beforeAll to avoid slow extension loading on every test.
 * Tables are truncated between tests for isolation.
 */
describe("GraphService (DuckDB)", () => {
	let graphService: GraphService;

	beforeAll(async () => {
		// Override path to use temp directory for tests
		setLatticeHomeForTesting(TEST_HOME);

		// Clean up any existing test data
		if (existsSync(TEST_HOME)) {
			rmSync(TEST_HOME, { recursive: true, force: true });
		}

		const configService = new TestConfigService();
		graphService = new GraphService(configService as unknown as ConfigService);
		await graphService.connect(); // Load extensions ONCE - this is slow
	});

	afterAll(async () => {
		// Disconnect and clean up
		await graphService.disconnect();
		if (existsSync(TEST_HOME)) {
			rmSync(TEST_HOME, { recursive: true, force: true });
		}
		// Reset the override
		setLatticeHomeForTesting(null);
	});

	beforeEach(async () => {
		// Clear data between tests, keep connection
		await graphService.query("DELETE FROM relationships");
		await graphService.query("DELETE FROM nodes");
	});

	describe("Connection Management", () => {
		it("should connect to DuckDB and initialize schema", async () => {
			// Connection happens in beforeEach, just verify it succeeded
			expect(graphService).toBeDefined();
		});

		it("should create database file at configured path", async () => {
			// getDatabasePath() returns the path based on the test override
			expect(existsSync(getDatabasePath())).toBe(true);
		});
	});

	describe("upsertNode()", () => {
		it("should create a new node", async () => {
			await graphService.upsertNode("Technology", {
				name: "TypeScript",
				version: "5.0",
			});

			const nodes = await graphService.findNodesByLabel("Technology");
			expect(nodes.length).toBe(1);
		});

		it("should update existing node with same name (upsert behavior)", async () => {
			await graphService.upsertNode("Technology", {
				name: "TypeScript",
				version: "4.0",
			});
			await graphService.upsertNode("Technology", {
				name: "TypeScript",
				version: "5.0",
			});

			const nodes = await graphService.findNodesByLabel("Technology");
			expect(nodes.length).toBe(1);
			// Verify the version was updated
			const node = nodes[0] as {
				name: string;
				properties: { version: string };
			};
			expect(
				node.properties?.version ||
					(node as unknown as { version: string }).version,
			).toBe("5.0");
		});

		it("should throw error if node has no name property", async () => {
			await expect(
				graphService.upsertNode("Technology", { version: "5.0" }),
			).rejects.toThrow("name");
		});

		it("should handle special characters in property values", async () => {
			await graphService.upsertNode("Document", {
				name: "Test's Document",
				path: '/docs/"special"/',
			});

			const nodes = await graphService.findNodesByLabel("Document");
			expect(nodes.length).toBe(1);
		});
	});

	describe("deleteNode()", () => {
		it("should delete a node by label and name", async () => {
			await graphService.upsertNode("Technology", { name: "ToDelete" });
			await graphService.deleteNode("Technology", "ToDelete");

			const nodes = await graphService.findNodesByLabel("Technology");
			const found = nodes.find(
				(n) => (n as { name: string }).name === "ToDelete",
			);
			expect(found).toBeUndefined();
		});

		it("should not throw when deleting non-existent node", async () => {
			await expect(
				graphService.deleteNode("Technology", "NonExistent"),
			).resolves.toBeUndefined();
		});
	});

	describe("findNodesByLabel()", () => {
		beforeEach(async () => {
			// Set up test data
			await graphService.upsertNode("Tool", { name: "Git", type: "vcs" });
			await graphService.upsertNode("Tool", {
				name: "Docker",
				type: "container",
			});
			await graphService.upsertNode("Tool", { name: "Vim", type: "editor" });
		});

		it("should find all nodes with a given label", async () => {
			const nodes = await graphService.findNodesByLabel("Tool");
			expect(nodes.length).toBe(3);
		});

		it("should support limit parameter", async () => {
			const nodes = await graphService.findNodesByLabel("Tool", 2);
			expect(nodes.length).toBe(2);
		});

		it("should return empty array when no nodes found", async () => {
			const nodes = await graphService.findNodesByLabel("NonExistent");
			expect(nodes).toEqual([]);
		});
	});

	describe("upsertRelationship()", () => {
		beforeEach(async () => {
			await graphService.upsertNode("Technology", { name: "TypeScript" });
			await graphService.upsertNode("Technology", { name: "Node.js" });
		});

		it("should create relationship between existing nodes", async () => {
			await graphService.upsertRelationship(
				"Technology",
				"TypeScript",
				"USES",
				"Technology",
				"Node.js",
			);

			const rels = await graphService.findRelationships("TypeScript");
			expect(rels.length).toBe(1);
		});

		it("should create nodes if they don't exist (MERGE behavior)", async () => {
			await graphService.upsertRelationship(
				"Technology",
				"React",
				"USES",
				"Technology",
				"JavaScript",
			);

			// Both nodes should have been created
			const nodes = await graphService.findNodesByLabel("Technology");
			const names = nodes.map((n) => (n as { name: string }).name);
			expect(names).toContain("React");
			expect(names).toContain("JavaScript");
		});

		it("should support relationship properties", async () => {
			await graphService.upsertRelationship(
				"Technology",
				"TypeScript",
				"USES",
				"Technology",
				"Node.js",
				{ confidence: 0.95, documentPath: "/docs/test.md" },
			);

			const rels = await graphService.findRelationships("TypeScript");
			expect(rels.length).toBe(1);
		});
	});

	describe("deleteDocumentRelationships()", () => {
		beforeEach(async () => {
			await graphService.upsertNode("Document", { name: "/docs/test.md" });
			await graphService.upsertNode("Technology", { name: "DuckDB" });
			await graphService.upsertRelationship(
				"Document",
				"/docs/test.md",
				"REFERENCES",
				"Technology",
				"DuckDB",
				{ documentPath: "/docs/test.md" },
			);
		});

		it("should delete relationships by documentPath", async () => {
			await graphService.deleteDocumentRelationships("/docs/test.md");

			const rels = await graphService.findRelationships("/docs/test.md");
			expect(rels.length).toBe(0);
		});

		it("should not delete unrelated relationships", async () => {
			// Create another relationship with different documentPath
			await graphService.upsertRelationship(
				"Document",
				"/docs/other.md",
				"REFERENCES",
				"Technology",
				"DuckDB",
				{ documentPath: "/docs/other.md" },
			);

			await graphService.deleteDocumentRelationships("/docs/test.md");

			const rels = await graphService.findRelationships("/docs/other.md");
			expect(rels.length).toBe(1);
		});
	});

	describe("findRelationships()", () => {
		beforeEach(async () => {
			await graphService.upsertNode("Technology", { name: "TypeScript" });
			await graphService.upsertNode("Technology", { name: "Node.js" });
			await graphService.upsertNode("Technology", { name: "Express" });
			await graphService.upsertRelationship(
				"Technology",
				"TypeScript",
				"USES",
				"Technology",
				"Node.js",
			);
			await graphService.upsertRelationship(
				"Technology",
				"TypeScript",
				"DEPENDS_ON",
				"Technology",
				"Express",
			);
		});

		it("should find all relationships for a node", async () => {
			const relationships = await graphService.findRelationships("TypeScript");
			expect(relationships.length).toBe(2);
		});

		it("should return empty array when no relationships found", async () => {
			const relationships =
				await graphService.findRelationships("IsolatedNode");
			expect(relationships).toEqual([]);
		});
	});

	describe("Vector Operations", () => {
		const EMBEDDING_DIM = 512;
		const createEmbedding = (seed: number): number[] => {
			// Create a deterministic embedding based on seed
			return Array.from({ length: EMBEDDING_DIM }, (_, i) =>
				Math.sin(seed * (i + 1) * 0.01),
			);
		};

		beforeEach(async () => {
			// Create vector index
			await graphService.createVectorIndex(
				"Document",
				"embedding",
				EMBEDDING_DIM,
			);
		});

		it("should create vector index without error", async () => {
			// Index created in beforeEach
			// Creating again should not throw (idempotent)
			await expect(
				graphService.createVectorIndex("Document", "embedding", EMBEDDING_DIM),
			).resolves.toBeUndefined();
		});

		it("should update node embedding", async () => {
			await graphService.upsertNode("Document", {
				name: "doc1.md",
				title: "Test Document",
			});

			const embedding = createEmbedding(1);
			await graphService.updateNodeEmbedding("Document", "doc1.md", embedding);

			// Verify by doing a search
			const results = await graphService.vectorSearch("Document", embedding, 1);
			expect(results.length).toBe(1);
			expect(results[0].name).toBe("doc1.md");
		});

		it("should return nodes ordered by similarity", async () => {
			// Create documents with different embeddings
			await graphService.upsertNode("Document", {
				name: "doc1.md",
				title: "Doc 1",
			});
			await graphService.upsertNode("Document", {
				name: "doc2.md",
				title: "Doc 2",
			});
			await graphService.upsertNode("Document", {
				name: "doc3.md",
				title: "Doc 3",
			});

			const embedding1 = createEmbedding(1);
			const embedding2 = createEmbedding(2);
			const embedding3 = createEmbedding(3);

			await graphService.updateNodeEmbedding("Document", "doc1.md", embedding1);
			await graphService.updateNodeEmbedding("Document", "doc2.md", embedding2);
			await graphService.updateNodeEmbedding("Document", "doc3.md", embedding3);

			// Query with embedding similar to doc1
			const queryVector = createEmbedding(1);
			const results = await graphService.vectorSearch(
				"Document",
				queryVector,
				3,
			);

			expect(results.length).toBe(3);
			expect(results[0].name).toBe("doc1.md"); // Most similar
			expect(results[0].score).toBeGreaterThan(results[1].score);
		});

		it("should search across all entity types", async () => {
			// Create various entity types with embeddings
			await graphService.createVectorIndex(
				"Technology",
				"embedding",
				EMBEDDING_DIM,
			);

			await graphService.upsertNode("Document", {
				name: "doc.md",
				title: "Doc",
			});
			await graphService.upsertNode("Technology", {
				name: "DuckDB",
				description: "Database",
			});

			await graphService.updateNodeEmbedding(
				"Document",
				"doc.md",
				createEmbedding(1),
			);
			await graphService.updateNodeEmbedding(
				"Technology",
				"DuckDB",
				createEmbedding(1.1),
			);

			const results = await graphService.vectorSearchAll(
				createEmbedding(1),
				10,
			);

			expect(results.length).toBeGreaterThanOrEqual(2);
			// Results should include both labels
			const labels = results.map((r) => r.label);
			expect(labels).toContain("Document");
			expect(labels).toContain("Technology");
		});
	});

	describe("query()", () => {
		it("should execute raw SQL query", async () => {
			await graphService.upsertNode("Technology", { name: "SQLTest" });

			const result = await graphService.query(
				"SELECT * FROM nodes WHERE label = 'Technology'",
			);

			expect(result.resultSet.length).toBeGreaterThan(0);
		});

		it("should return empty result set for no matches", async () => {
			const result = await graphService.query(
				"SELECT * FROM nodes WHERE label = 'NonExistent'",
			);

			expect(result.resultSet).toEqual([]);
		});
	});
});
