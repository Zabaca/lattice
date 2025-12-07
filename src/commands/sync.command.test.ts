import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type {
	SyncOptions,
	SyncResult,
	SyncService,
} from "../sync/sync.service.js";
import type { ConsoleSpy, ProcessExitSpy } from "../testing/mock-types.js";
import { SyncCommand } from "./sync.command.js";

describe("SyncCommand", () => {
	let command: SyncCommand;
	let mockSyncService: Partial<SyncService>;
	let consoleLogSpy: ConsoleSpy;
	let _consoleErrorSpy: ConsoleSpy;
	let processExitSpy: ProcessExitSpy;

	beforeEach(() => {
		mockSyncService = {
			sync: mock(
				async (options: SyncOptions): Promise<SyncResult> => ({
					added: 5,
					updated: 3,
					deleted: 1,
					unchanged: 10,
					errors: [],
					duration: 1500,
					changes: [
						{
							path: "docs/test/doc.md",
							changeType: "new" as const,
							reason: "New document",
						},
						{
							path: "docs/other/file.md",
							changeType: "unchanged" as const,
							reason: "No changes detected",
						},
					],
					cascadeWarnings: [],
					embeddingsGenerated: options.embeddings ? 3 : 0,
					entityEmbeddingsGenerated: 0,
				}),
			),
		};

		command = new SyncCommand(mockSyncService as SyncService);

		consoleLogSpy = spyOn(console, "log") as ConsoleSpy;
		_consoleErrorSpy = spyOn(console, "error") as ConsoleSpy;
		processExitSpy = spyOn(process, "exit") as unknown as ProcessExitSpy;
		processExitSpy.mockImplementation(() => {
			throw new Error("PROCESS_EXIT_CALLED");
		});
	});

	describe("run", () => {
		it("should sync with default options", async () => {
			try {
				await command.run([], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			expect(mockSyncService.sync.mock.calls.length).toBe(1);
			const callOptions = mockSyncService.sync.mock.calls[0][0];
			expect(callOptions.force).toBeUndefined();
			expect(callOptions.dryRun).toBeFalsy();
			expect(callOptions.embeddings).toBe(true);
		});

		it("should print results correctly", async () => {
			try {
				await command.run([], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Graph Sync");
			expect(logs.join("\n")).toContain("Sync Results");
			expect(logs.join("\n")).toContain("Added: 5");
			expect(logs.join("\n")).toContain("Updated: 3");
			expect(logs.join("\n")).toContain("Deleted: 1");
		});

		it("should handle force mode with warning", async () => {
			try {
				await command.run([], { force: true });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Force mode");
			expect(logs.join("\n")).toContain("cleared and rebuilt");
		});

		it("should handle dry-run mode with message", async () => {
			try {
				await command.run([], { dryRun: true });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Dry run mode");
			expect(logs.join("\n")).toContain("No changes will be applied");
		});

		it("should handle diff option as alias for dry-run", async () => {
			try {
				await command.run([], { diff: true });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Dry run mode");
		});

		it("should pass options correctly to SyncService", async () => {
			try {
				await command.run([], { force: true, verbose: true });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			expect(mockSyncService.sync.mock.calls.length).toBe(1);
			const callOptions = mockSyncService.sync.mock.calls[0][0];
			expect(callOptions.force).toBe(true);
			expect(callOptions.verbose).toBe(true);
		});

		it("should handle specific paths", async () => {
			try {
				await command.run(["docs/topic/file.md", "docs/other/"], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			expect(mockSyncService.sync.mock.calls.length).toBe(1);
			const callOptions = mockSyncService.sync.mock.calls[0][0];
			expect(callOptions.paths).toEqual(["docs/topic/file.md", "docs/other/"]);
		});

		it("should handle sync errors", async () => {
			mockSyncService.sync = mock(
				async (): Promise<SyncResult> => ({
					added: 0,
					updated: 0,
					deleted: 0,
					unchanged: 0,
					errors: [
						{
							path: "docs/broken/file.md",
							error: "Parse error: Invalid YAML",
						},
					],
					duration: 500,
					changes: [],
					cascadeWarnings: [],
					embeddingsGenerated: 0,
				}),
			);

			try {
				await command.run([], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Errors");
			expect(logs.join("\n")).toContain("Parse error");
		});

		it("should show suggestion to run without --dry-run", async () => {
			try {
				await command.run([], { dryRun: true });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Run without --dry-run");
		});

		it("should reject watch + dry-run combination", async () => {
			try {
				await command.run([], { watch: true, dryRun: true });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain(
				"Watch mode is not compatible with --dry-run",
			);
		});

		it("should reject watch + force combination", async () => {
			try {
				await command.run([], { watch: true, force: true });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain(
				"Watch mode is not compatible with --force",
			);
		});
	});

	describe("embedding options", () => {
		it("should enable embeddings by default", async () => {
			try {
				await command.run([], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			expect(mockSyncService.sync.mock.calls.length).toBe(1);
			const callOptions = mockSyncService.sync.mock.calls[0][0];
			expect(callOptions.embeddings).toBe(true);
		});

		it("should disable embeddings when embeddings option is false", async () => {
			try {
				await command.run([], { embeddings: false });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			expect(mockSyncService.sync.mock.calls.length).toBe(1);
			const callOptions = mockSyncService.sync.mock.calls[0][0];
			expect(callOptions.embeddings).toBe(false);
		});

		it("should display embeddings count in results when > 0", async () => {
			try {
				await command.run([], {});
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Embeddings: 3");
		});

		it("should not display embeddings count when 0", async () => {
			// Track calls before this test
			const callsBefore = consoleLogSpy.mock.calls.length;

			try {
				await command.run([], { embeddings: false });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			// Only check logs from this test run
			const newLogs = consoleLogSpy.mock.calls
				.slice(callsBefore)
				.map((call) => call[0]);
			const joinedLogs = newLogs.join("\n");
			expect(joinedLogs).not.toContain("Embeddings:");
		});

		it("should show message when embeddings are disabled", async () => {
			try {
				await command.run([], { embeddings: false });
			} catch (_e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
			expect(logs.join("\n")).toContain("Embedding generation disabled");
		});
	});

});
