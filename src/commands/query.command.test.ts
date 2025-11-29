import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Command } from "commander";
import { NestFactory } from "@nestjs/core";
import { registerQueryCommands } from "./query.command.js";
import type { CypherResult } from "../graph/graph.types.js";

// Mock the NestFactory
mock.module("@nestjs/core", () => ({
	NestFactory: {
		createApplicationContext: mock(),
	},
}));

describe("Query Commands - Search", () => {
	let mockGraphService: any;
	let mockEmbeddingService: any;
	let mockApp: any;
	let program: Command;

	beforeEach(() => {
		// Setup mock services
		mockGraphService = {
			vectorSearch: mock(async () => []),
			vectorSearchAll: mock(async () => []),
			query: mock(async () => ({ resultSet: [] })),
		};

		mockEmbeddingService = {
			generateEmbedding: mock(async () => [0.1, 0.2, 0.3]),
		};

		// Setup mock app
		mockApp = {
			get: mock((service: any) => {
				// Support both class constructors and string service names
				const serviceName = typeof service === "string" ? service : service?.name;
				if (serviceName === "EmbeddingService") {
					return mockEmbeddingService;
				}
				return mockGraphService;
			}),
			close: mock(async () => {}),
		};

		// Mock NestFactory
		const mockNestFactory = require("@nestjs/core");
		mockNestFactory.NestFactory.createApplicationContext = mock(
			async () => mockApp
		);

		// Create new program for each test
		program = new Command();
		registerQueryCommands(program);
	});

	describe("search command", () => {
		it("should perform semantic search with query", async () => {
			const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
			mockEmbeddingService.generateEmbedding = mock(
				async () => mockEmbedding
			);
			mockGraphService.vectorSearchAll = mock(async () => [
				{ name: "TestEntity", label: "Technology", score: 0.95 }
			]);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			const originalExit = process.exit;
			process.exit = ((code?: number) => {}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"test query",
				]);
			} catch (e) {
				// Ignore parse errors
			}

			// Verify the output shows semantic search results
			expect(
				consoleOutput.includes("Semantic Search Results") ||
				consoleOutput.includes("TestEntity")
			).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should filter by label when --label is used", async () => {
			const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
			mockEmbeddingService.generateEmbedding = mock(
				async () => mockEmbedding
			);
			mockGraphService.vectorSearch = mock(async () => [
				{ name: "TypeScript", title: "TypeScript Language", score: 0.9 }
			]);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			const originalExit = process.exit;
			process.exit = ((code?: number) => {}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"typescript",
					"--label",
					"Technology",
				]);
			} catch (e) {
				// Ignore
			}

			// Verify vectorSearch was called (for label-specific search)
			expect(mockGraphService.vectorSearch.mock.calls.length).toBeGreaterThan(0);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should support limit option", async () => {
			mockGraphService.vectorSearchAll = mock(async () => []);
			mockEmbeddingService.generateEmbedding = mock(async () => [0.1, 0.2]);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			const originalExit = process.exit;
			process.exit = ((code?: number) => {}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"test query",
					"--limit",
					"50",
				]);
			} catch (e) {
				// Ignore
			}

			// Should run without error
			expect(consoleOutput.includes("Semantic Search Results") || consoleOutput.includes("No results")).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should show no results message when nothing found", async () => {
			mockGraphService.vectorSearchAll = mock(async () => []);
			mockEmbeddingService.generateEmbedding = mock(async () => [0.1, 0.2]);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			const originalExit = process.exit;
			process.exit = ((code?: number) => {}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"nonexistent query",
				]);
			} catch (e) {
				// Ignore
			}

			expect(consoleOutput.includes("No results found")).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should show results with similarity scores", async () => {
			mockEmbeddingService.generateEmbedding = mock(async () => [0.1, 0.2]);
			mockGraphService.vectorSearchAll = mock(async () => [
				{ name: "FalkorDB", label: "Technology", description: "Graph database", score: 0.95 }
			]);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			const originalExit = process.exit;
			process.exit = ((code?: number) => {}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"graph database",
				]);
			} catch (e) {
				// Ignore
			}

			expect(consoleOutput.includes("FalkorDB")).toBe(true);
			expect(consoleOutput.includes("Similarity:")).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should suggest trying without --label when no results with label", async () => {
			mockEmbeddingService.generateEmbedding = mock(async () => [0.1, 0.2]);
			mockGraphService.vectorSearch = mock(async () => []);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			const originalExit = process.exit;
			process.exit = ((code?: number) => {}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"test",
					"--label",
					"NonexistentType",
				]);
			} catch (e) {
				// Ignore
			}

			expect(consoleOutput.includes("Try without --label")).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});
	});
});
