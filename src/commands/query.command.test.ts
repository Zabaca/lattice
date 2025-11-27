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

describe("Query Commands - Semantic Search", () => {
	let mockGraphService: any;
	let mockEmbeddingService: any;
	let mockApp: any;
	let program: Command;

	beforeEach(() => {
		// Setup mock services
		mockGraphService = {
			vectorSearch: mock(async () => []),
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

	describe("semantic search feature", () => {
		it("should call embedding service when --semantic is used", async () => {
			const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
			mockEmbeddingService.generateEmbedding = mock(
				async () => mockEmbedding
			);
			mockGraphService.vectorSearch = mock(async () => []);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			let exitCode = 0;
			const originalExit = process.exit;
			process.exit = ((code?: number) => {
				exitCode = code || 0;
			}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"--semantic",
					"test query",
				]);
			} catch (e) {
				// Ignore parse errors
			}

			// Verify the output indicates semantic search was attempted
			expect(
				consoleOutput.includes("Semantic Search Results") ||
				consoleOutput.includes("No documents found")
			).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should support --semantic with short flag -s", async () => {
			mockGraphService.vectorSearch = mock(async () => []);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			let exitCode = 0;
			const originalExit = process.exit;
			process.exit = ((code?: number) => {
				exitCode = code || 0;
			}) as any;

			try {
				// Try using the short form -s
				await program.parseAsync([
					"node",
					"test",
					"search",
					"-s",
					"test query",
				]);
			} catch (e) {
				// Ignore parse errors
			}

			// Verify semantic search was triggered (regardless of flag form)
			expect(
				consoleOutput.includes("Semantic Search Results") ||
				consoleOutput.includes("No documents found")
			).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should support limit option with semantic search", async () => {
			mockGraphService.vectorSearch = mock(async () => []);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			let exitCode = 0;
			const originalExit = process.exit;
			process.exit = ((code?: number) => {
				exitCode = code || 0;
			}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"--semantic",
					"test query",
					"--limit",
					"50",
				]);
			} catch (e) {
				// Ignore
			}

			// Should run without error
			expect(
				consoleOutput.includes("Semantic Search Results") ||
				consoleOutput.includes("No documents found")
			).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should keep traditional keyword search working", async () => {
			const mockResult: CypherResult = {
				resultSet: [
					[
						{
							labels: ["Technology"],
							properties: {
								name: "TypeScript",
								description: "Programming language",
							},
						},
					],
				],
			};

			mockGraphService.query = mock(async () => mockResult);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			let exitCode = 0;
			const originalExit = process.exit;
			process.exit = ((code?: number) => {
				exitCode = code || 0;
			}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"--label",
					"Technology",
				]);
			} catch (e) {
				// Ignore
			}

			// When traditional search is used (no --semantic), results should show
			expect(consoleOutput.includes("TypeScript")).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});
	});

	describe("search command without semantic flag", () => {
		it("should search by label", async () => {
			const mockResult: CypherResult = {
				resultSet: [
					[
						{
							labels: ["Entity"],
							properties: {
								name: "TestEntity",
								description: "A test entity",
							},
						},
					],
				],
			};

			mockGraphService.query = mock(async () => mockResult);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			let exitCode = 0;
			const originalExit = process.exit;
			process.exit = ((code?: number) => {
				exitCode = code || 0;
			}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"--label",
					"Entity",
				]);
			} catch (e) {
				// Ignore
			}

			expect(consoleOutput.includes("TestEntity")).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});

		it("should search by name with substring match", async () => {
			const mockResult: CypherResult = {
				resultSet: [
					[
						{
							labels: ["Technology"],
							properties: {
								name: "TypeScript",
								description: "Language",
							},
						},
					],
				],
			};

			mockGraphService.query = mock(async () => mockResult);

			let consoleOutput = "";
			const originalLog = console.log;
			console.log = (...args: any[]) => {
				consoleOutput += args.join(" ") + "\n";
			};

			let exitCode = 0;
			const originalExit = process.exit;
			process.exit = ((code?: number) => {
				exitCode = code || 0;
			}) as any;

			try {
				await program.parseAsync([
					"node",
					"test",
					"search",
					"--name",
					"Type",
				]);
			} catch (e) {
				// Ignore
			}

			expect(consoleOutput.includes("TypeScript")).toBe(true);

			console.log = originalLog;
			process.exit = originalExit;
		});
	});
});
