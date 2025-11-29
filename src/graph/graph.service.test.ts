import { describe, it, expect, beforeEach } from "bun:test";
import { GraphService } from "./graph.service.js";
import { ConfigService } from "@nestjs/config";
import type Redis from "ioredis";

// Simple mock implementation
class MockRedis {
	private callMock = {
		calls: [] as any[],
		resolvedValue: null as any,
		rejectedError: null as any,
	};

	async call(...args: any[]): Promise<any> {
		this.callMock.calls.push(args);
		if (this.callMock.rejectedError) {
			throw this.callMock.rejectedError;
		}
		return this.callMock.resolvedValue;
	}

	async ping(): Promise<string> {
		return "PONG";
	}

	async quit(): Promise<void> {
		return;
	}

	setMockResolvedValue(value: any) {
		this.callMock.resolvedValue = value;
		this.callMock.rejectedError = null;
	}

	setMockRejectedError(error: Error) {
		this.callMock.rejectedError = error;
	}

	getMockCalls() {
		return this.callMock.calls;
	}

	clearMockCalls() {
		this.callMock.calls = [];
	}
}

class MockConfigService {
	get(key: string, defaultValue?: any): any {
		const config: Record<string, any> = {
			FALKORDB_HOST: "localhost",
			FALKORDB_PORT: 6379,
			GRAPH_NAME: "research_knowledge",
		};
		return config[key] ?? defaultValue;
	}
}

describe("GraphService", () => {
	let graphService: GraphService;
	let mockRedis: MockRedis;
	let mockConfigService: MockConfigService;

	beforeEach(() => {
		mockRedis = new MockRedis();
		mockConfigService = new MockConfigService();
		graphService = new GraphService(
			mockConfigService as any as ConfigService
		);
		(graphService as any).redis = mockRedis as any as Redis;
	});

	describe("Connection Management", () => {
		it("should initialize with config from environment", () => {
			expect((graphService as any).config).toEqual({
				host: "localhost",
				port: 6379,
				graphName: "research_knowledge",
			});
		});

		it("should use default values when environment variables are not set", () => {
			const customConfigService = new MockConfigService();
			const service = new GraphService(
				customConfigService as any as ConfigService
			);

			expect((service as any).config).toEqual({
				host: "localhost",
				port: 6379,
				graphName: "research_knowledge",
			});
		});
	});

	describe("query()", () => {
		it("should execute a raw Cypher query", async () => {
			// FalkorDB returns: [headers, rows, stats]
			const testData = [
				["n"],  // column headers
				[["value1"], ["value2"]],  // data rows
				"Nodes created: 0",  // stats
			];
			mockRedis.setMockResolvedValue(testData);

			const result = await graphService.query(
				"MATCH (n) RETURN n LIMIT 10"
			);

			expect(mockRedis.getMockCalls().length).toBeGreaterThan(0);
			expect(result.resultSet).toEqual([["value1"], ["value2"]]);
		});

		it("should parse stats from query result", async () => {
			// FalkorDB returns: [headers, rows, stats]
			const testData = [
				[],  // headers
				[],  // rows
				"Nodes created: 2, Relationships created: 1, Properties set: 5",  // stats
			];
			mockRedis.setMockResolvedValue(testData);

			const result = await graphService.query("CREATE (n:Test)");

			expect(result.stats).toEqual({
				nodesCreated: 2,
				nodesDeleted: 0,
				relationshipsCreated: 1,
				relationshipsDeleted: 0,
				propertiesSet: 5,
			});
		});

		it("should handle empty result sets", async () => {
			// FalkorDB returns: [headers, rows, stats]
			mockRedis.setMockResolvedValue([[], [], "Query OK"]);

			const result = await graphService.query(
				"MATCH (n:NonExistent) RETURN n"
			);

			expect(result.resultSet).toEqual([]);
		});

		it("should throw error on query failure", async () => {
			const error = new Error("Connection failed");
			mockRedis.setMockRejectedError(error);

			try {
				await graphService.query("MATCH (n) RETURN n");
				expect(true).toBe(false); // Should not reach here
			} catch (e) {
				expect(e).toEqual(error);
			}
		});
	});

	describe("upsertNode()", () => {
		it("should create or update a node", async () => {
			// FalkorDB returns: [headers, rows, stats]
			mockRedis.setMockResolvedValue([
				[],  // headers
				[],  // rows
				"Nodes created: 1, Properties set: 2",  // stats
			]);
			mockRedis.clearMockCalls();

			await graphService.upsertNode("Technology", {
				name: "TypeScript",
				version: "5.0",
			});

			const calls = mockRedis.getMockCalls();
			expect(calls.length).toBeGreaterThan(0);
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toContain("MERGE");
			expect(cypher).toContain("Technology");
			expect(cypher).toContain("TypeScript");
		});

		it("should escape special characters in property values", async () => {
			mockRedis.setMockResolvedValue([[], [], "Nodes created: 1"]);
			mockRedis.clearMockCalls();

			await graphService.upsertNode("Document", {
				name: "Test's Document",
				path: '/docs/"special"/',
			});

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toBeDefined();
			// Should contain escaped quotes
			expect(cypher.includes("\\'")).toBe(true);
		});

		it("should throw error on upsert failure", async () => {
			const error = new Error("Database error");
			mockRedis.setMockRejectedError(error);

			try {
				await graphService.upsertNode("Technology", {
					name: "TypeScript",
				});
				expect(true).toBe(false); // Should not reach here
			} catch (e) {
				expect((e as Error).message).toContain("Database error");
			}
		});

		it("should throw error if node has no name property", async () => {
			try {
				await graphService.upsertNode("Technology", {
					version: "5.0",
				});
				expect(true).toBe(false); // Should not reach here
			} catch (e) {
				expect((e as Error).message).toContain("name");
			}
		});
	});

	describe("upsertRelationship()", () => {
		it("should create or update a relationship", async () => {
			mockRedis.setMockResolvedValue([
				[],  // headers
				[],  // rows
				"Relationships created: 1",  // stats
			]);
			mockRedis.clearMockCalls();

			await graphService.upsertRelationship(
				"Technology",
				"TypeScript",
				"USES",
				"Technology",
				"Node.js"
			);

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toContain("MERGE");
			expect(cypher).toContain("USES");
			expect(cypher).toContain("TypeScript");
			expect(cypher).toContain("Node.js");
		});

		it("should support relationship properties", async () => {
			mockRedis.setMockResolvedValue([
				[],  // headers
				[],  // rows
				"Relationships created: 1",  // stats
			]);
			mockRedis.clearMockCalls();

			await graphService.upsertRelationship(
				"Technology",
				"TypeScript",
				"USES",
				"Technology",
				"Node.js",
				{ confidence: 0.95 }
			);

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toContain("confidence");
		});

		it("should throw error on relationship upsert failure", async () => {
			mockRedis.setMockRejectedError(new Error("Relationship failed"));

			try {
				await graphService.upsertRelationship(
					"Technology",
					"TypeScript",
					"USES",
					"Technology",
					"Node.js"
				);
				expect(true).toBe(false); // Should not reach here
			} catch (e) {
				expect((e as Error).message).toContain("Relationship failed");
			}
		});
	});

	describe("deleteNode()", () => {
		it("should delete a node by label and name", async () => {
			mockRedis.setMockResolvedValue([[], [], "Nodes deleted: 1"]);
			mockRedis.clearMockCalls();

			await graphService.deleteNode("Technology", "TypeScript");

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toContain("MATCH");
			expect(cypher).toContain("DELETE");
			expect(cypher).toContain("Technology");
			expect(cypher).toContain("TypeScript");
		});

		it("should throw error on delete failure", async () => {
			mockRedis.setMockRejectedError(new Error("Delete failed"));

			try {
				await graphService.deleteNode("Technology", "TypeScript");
				expect(true).toBe(false); // Should not reach here
			} catch (e) {
				expect((e as Error).message).toContain("Delete failed");
			}
		});
	});

	describe("deleteDocumentRelationships()", () => {
		it("should delete relationships for a document path", async () => {
			mockRedis.setMockResolvedValue([
				[],  // headers
				[],  // rows
				"Relationships deleted: 3",  // stats
			]);
			mockRedis.clearMockCalls();

			await graphService.deleteDocumentRelationships(
				"docs/research/topic.md"
			);

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toContain("documentPath");
			expect(cypher).toContain("docs/research/topic.md");
		});

		it("should handle document paths with special characters", async () => {
			mockRedis.setMockResolvedValue([
				[],  // headers
				[],  // rows
				"Relationships deleted: 0",  // stats
			]);
			mockRedis.clearMockCalls();

			await graphService.deleteDocumentRelationships(
				'docs/"special"/file.md'
			);

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toBeDefined();
		});
	});

	describe("findNodesByLabel()", () => {
		it("should find nodes by label", async () => {
			// FalkorDB returns: [headers, rows, stats]
			mockRedis.setMockResolvedValue([
				["n"],  // headers
				[
					[
						{
							name: "TypeScript",
							version: "5.0",
						},
					],
					[
						{
							name: "JavaScript",
							version: "ES2022",
						},
					],
				],  // rows
				"Query OK",  // stats
			]);

			const nodes = await graphService.findNodesByLabel("Technology");

			expect(nodes.length).toBe(2);
			expect(nodes[0]).toEqual({
				name: "TypeScript",
				version: "5.0",
			});
		});

		it("should support limit parameter", async () => {
			// FalkorDB returns: [headers, rows, stats]
			mockRedis.setMockResolvedValue([
				["n"],  // headers
				[
					[
						{
							name: "TypeScript",
						},
					],
				],  // rows
				"Query OK",  // stats
			]);
			mockRedis.clearMockCalls();

			await graphService.findNodesByLabel("Technology", 1);

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toContain("LIMIT 1");
		});

		it("should return empty array when no nodes found", async () => {
			mockRedis.setMockResolvedValue([[], [], "Query OK"]);

			const nodes = await graphService.findNodesByLabel("NonExistent");

			expect(nodes).toEqual([]);
		});
	});

	describe("findRelationships()", () => {
		it("should find relationships for a node", async () => {
			// FalkorDB returns: [headers, rows, stats]
			mockRedis.setMockResolvedValue([
				["type(r)", "endNode.name"],  // headers
				[
					["USES", "Node.js"],
					["DEPENDS_ON", "Express"],
				],  // rows
				"Query OK",  // stats
			]);

			const relationships = await graphService.findRelationships(
				"TypeScript"
			);

			expect(relationships.length).toBe(2);
		});

		it("should return empty array when no relationships found", async () => {
			mockRedis.setMockResolvedValue([[], [], "Query OK"]);

			const relationships = await graphService.findRelationships(
				"IsolatedNode"
			);

			expect(relationships).toEqual([]);
		});
	});

	describe("Cypher escaping", () => {
		it("should properly escape backslashes", async () => {
			mockRedis.setMockResolvedValue([[], [], "Nodes created: 1"]);
			mockRedis.clearMockCalls();

			await graphService.upsertNode("Document", {
				name: 'Path\\with\\backslash',
			});

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			// Should have escaped backslashes in the query
			expect(cypher).toContain("\\\\");
		});

		it("should properly escape single quotes", async () => {
			mockRedis.setMockResolvedValue([[], [], "Nodes created: 1"]);
			mockRedis.clearMockCalls();

			await graphService.upsertNode("Document", {
				name: "O'Reilly",
			});

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toContain("\\'");
		});

		it("should properly escape double quotes", async () => {
			mockRedis.setMockResolvedValue([[], [], "Nodes created: 1"]);
			mockRedis.clearMockCalls();

			await graphService.upsertNode("Document", {
				name: 'He said "hello"',
			});

			const calls = mockRedis.getMockCalls();
			const cypher = calls[calls.length - 1][2];
			expect(cypher).toBeDefined();
		});
	});
});
