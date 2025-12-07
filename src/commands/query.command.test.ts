import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { EmbeddingService } from "../embedding/embedding.service.js";
import type { GraphService } from "../graph/graph.service.js";
import type { ConsoleSpy, ProcessExitSpy } from "../testing/mock-types.js";
import { RelsCommand, SearchCommand, SqlCommand } from "./query.command.js";

describe("Query Commands", () => {
	let mockGraphService: Partial<GraphService>;
	let mockEmbeddingService: Partial<EmbeddingService>;
	let consoleLogSpy: ConsoleSpy;
	let _consoleErrorSpy: ConsoleSpy;
	let processExitSpy: ProcessExitSpy;

	beforeEach(() => {
		mockGraphService = {
			vectorSearch: mock(async () => []),
			vectorSearchAll: mock(async () => []),
			query: mock(async () => ({ resultSet: [] })),
			findRelationships: mock(async () => []),
		};

		mockEmbeddingService = {
			generateEmbedding: mock(async () => [0.1, 0.2, 0.3]),
		};

		consoleLogSpy = spyOn(console, "log") as ConsoleSpy;
		consoleLogSpy.mockClear();
		_consoleErrorSpy = spyOn(console, "error") as ConsoleSpy;
		_consoleErrorSpy.mockClear();
		processExitSpy = spyOn(process, "exit") as unknown as ProcessExitSpy;
		processExitSpy.mockImplementation(() => {
			throw new Error("PROCESS_EXIT_CALLED");
		});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		_consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	describe("SearchCommand", () => {
		it("should perform semantic search with query", async () => {
			mockGraphService.vectorSearchAll = mock(async () => [
				{ name: "TestEntity", label: "Technology", score: 0.95 },
			]);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService,
			);

			try {
				await command.run(["test query"], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			const output = logs.join("\n");
			expect(
				output.includes("Semantic Search Results") ||
					output.includes("TestEntity"),
			).toBe(true);
		});

		it("should filter by label when --label is used", async () => {
			mockGraphService.vectorSearch = mock(async () => [
				{ name: "TypeScript", title: "TypeScript Language", score: 0.9 },
			]);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService,
			);

			try {
				await command.run(["typescript"], { label: "Technology" });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			// Verify vectorSearch was called (for label-specific search)
			expect(mockGraphService.vectorSearch.mock.calls.length).toBeGreaterThan(
				0,
			);
		});

		it("should show no results message when nothing found", async () => {
			mockGraphService.vectorSearchAll = mock(async () => []);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService,
			);

			try {
				await command.run(["nonexistent query"], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("No results found");
		});

		it("should show results with similarity scores", async () => {
			mockGraphService.vectorSearchAll = mock(async () => [
				{
					name: "FalkorDB",
					label: "Technology",
					description: "Graph database",
					score: 0.95,
				},
			]);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService,
			);

			try {
				await command.run(["graph database"], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("FalkorDB");
			expect(logs.join("\n")).toContain("Similarity:");
		});

		it("should suggest trying without --label when no results with label", async () => {
			mockGraphService.vectorSearch = mock(async () => []);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService,
			);

			try {
				await command.run(["test"], { label: "NonexistentType" });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Try without --label");
		});

		it("parseLabel should return the value", () => {
			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService,
			);
			expect(command.parseLabel("Technology")).toBe("Technology");
		});

		it("parseLimit should return the value", () => {
			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService,
			);
			expect(command.parseLimit("50")).toBe("50");
		});
	});

	describe("RelsCommand", () => {
		it("should show relationships for a node", async () => {
			// findRelationships returns [relType, otherNodeName] tuples
			mockGraphService.findRelationships = mock(async () => [
				["USES", "Redis"],
				["DEPENDS_ON", "TypeScript"],
			]);

			const command = new RelsCommand(mockGraphService as GraphService);

			try {
				await command.run(["FalkorDB"]);
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain('Relationships for "FalkorDB"');
		});

		it("should show no relationships message when none found", async () => {
			mockGraphService.findRelationships = mock(async () => []);

			const command = new RelsCommand(mockGraphService as GraphService);

			try {
				await command.run(["NonexistentNode"]);
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("No relationships found");
		});
	});

	describe("SqlCommand", () => {
		it("should execute raw SQL query", async () => {
			mockGraphService.query = mock(async () => ({
				resultSet: [["test result"]],
			}));

			const command = new SqlCommand(mockGraphService as GraphService);

			try {
				await command.run(["SELECT * FROM nodes LIMIT 1"]);
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("SQL Query Results");
		});
	});
});
