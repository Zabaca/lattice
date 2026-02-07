import { watch } from "node:fs";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { GraphService } from "../graph/graph.service.js";
import { GraphValidatorService } from "../sync/graph-validator.service.js";
import type { ChangeType, DocumentChange } from "../sync/manifest.service.js";
import { SyncOptions, SyncResult, SyncService } from "../sync/sync.service.js";

interface SyncCommandOptions {
	force?: boolean;
	dryRun?: boolean;
	verbose?: boolean;
	watch?: boolean;
	diff?: boolean;
	skipCascade?: boolean;
	embeddings?: boolean;
	skipExtraction?: boolean;
}

@Injectable()
@Command({
	name: "sync",
	arguments: "[paths...]",
	description: "Synchronize documents to the knowledge graph",
})
export class SyncCommand extends CommandRunner {
	private watcher: ReturnType<typeof watch> | null = null;
	private isShuttingDown = false;

	constructor(
		private readonly syncService: SyncService,
		private readonly graphService: GraphService,
		readonly _graphValidator: GraphValidatorService,
	) {
		super();
	}

	/**
	 * Safely exit the process after ensuring database cleanup.
	 */
	private async safeExit(code: number): Promise<never> {
		try {
			await this.graphService.checkpoint();
		} catch (_error) {
			// Log but don't fail - we're exiting anyway
			console.error("Warning: checkpoint failed during exit");
		}
		process.exit(code);
	}

	async run(paths: string[], options: SyncCommandOptions): Promise<void> {
		// Watch mode is incompatible with dry-run
		if (options.watch && options.dryRun) {
			console.log("\n⚠️  Watch mode is not compatible with --dry-run mode\n");
			await this.safeExit(1);
		}

		// Watch mode is incompatible with force mode (for safety)
		if (options.watch && options.force) {
			console.log(
				"\n⚠️  Watch mode is not compatible with --force mode (for safety)\n",
			);
			await this.safeExit(1);
		}

		// --force requires specific paths to prevent accidental full refreshes
		if (options.force && paths.length === 0) {
			console.log("\n⚠️  --force requires specific paths to be specified.\n");
			console.log("   Usage: lattice sync --force <path1> [path2] ...\n");
			await this.safeExit(1);
		}

		const syncOptions: SyncOptions = {
			force: options.force,
			dryRun: options.dryRun || options.diff,
			verbose: options.verbose,
			paths: paths.length > 0 ? paths : undefined,
			skipCascade: options.skipCascade,
			embeddings: options.embeddings !== false, // Default true, --no-embeddings sets to false
			aiExtraction: !options.skipExtraction, // Can skip AI extraction
		};

		console.log("\n🔄 Graph Sync\n");

		if (syncOptions.force) {
			console.log(
				`⚠️  Force mode: ${syncOptions.paths?.length} document(s) will be cleared and re-synced\n`,
			);
		}

		if (syncOptions.dryRun) {
			console.log("📋 Dry run mode: No changes will be applied\n");
		}

		if (syncOptions.skipCascade) {
			console.log("⚡ Cascade analysis skipped\n");
		}

		if (!syncOptions.embeddings) {
			console.log("🚫 Embedding generation disabled\n");
		}

		if (!syncOptions.aiExtraction) {
			console.log("⏭️  AI entity extraction skipped (--skip-extraction)\n");
		}

		if (syncOptions.paths) {
			console.log(
				`📁 Syncing specific paths: ${syncOptions.paths.join(", ")}\n`,
			);
		}

		// TODO: Validation now happens during sync via frontmatter validation
		// Graph validation is disabled - focusing on markdown as source of truth
		/*
		// Validate before syncing (unless force mode or dry-run)
		if (!syncOptions.force && !syncOptions.dryRun) {
			console.log("🔍 Validating graph before sync...\n");
			try {
				const validationResult = await this.graphValidator.validateGraph();
				if (!validationResult.valid) {
					console.log(
						`\n❌ Graph validation failed with ${validationResult.stats.errorsFound} error(s)\n`,
					);
					console.log("Errors found:");
					validationResult.issues
						.filter((i) => i.type === "error")
						.slice(0, 5)
						.forEach((issue) => {
							console.log(
								`  - [${issue.nodeLabel}] ${issue.nodeName}: ${issue.message}`,
							);
						});
					if (validationResult.stats.errorsFound > 5) {
						console.log(
							`  ... and ${validationResult.stats.errorsFound - 5} more\n`,
						);
					}
					console.log(
						"\n💡 Run 'lattice validate --fix' to see all issues and suggestions",
					);
					console.log(
						"💡 Or use 'lattice sync --force' to bypass validation and rebuild graph\n",
					);
					process.exit(1);
				}
				console.log("✓ Graph validation passed\n");
			} catch (error) {
				console.log(
					`⚠️  Validation check failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				console.log("Continuing with sync...\n");
			}
		}
	*/

		try {
			// Initial sync
			const initialResult = await this.syncService.sync(syncOptions);
			this.printSyncResults(initialResult, options.watch);

			if (options.dryRun) {
				console.log("💡 Run without --dry-run to apply changes");
			}

			// Enter watch mode if requested
			if (options.watch) {
				await this.enterWatchMode(syncOptions);
			} else {
				await this.safeExit(initialResult.errors.length > 0 ? 1 : 0);
			}
		} catch (error) {
			console.error(
				"\n❌ Sync failed:",
				error instanceof Error ? error.message : String(error),
			);
			await this.safeExit(1);
		}
	}

	private async enterWatchMode(syncOptions: SyncOptions): Promise<void> {
		const docsPath = process.env.DOCS_PATH || "docs";

		// Debounce state
		let debounceTimeout: NodeJS.Timeout | null = null;
		const trackedFiles = new Set<string>();

		/**
		 * Debounced sync function to avoid multiple syncs for rapid changes
		 * Collects multiple file changes within a 500ms window into a single sync
		 */
		const debouncedSync = () => {
			if (debounceTimeout) {
				clearTimeout(debounceTimeout);
			}

			debounceTimeout = setTimeout(async () => {
				if (this.isShuttingDown) return;

				if (trackedFiles.size === 0) return;

				try {
					const changedPaths = Array.from(trackedFiles);
					trackedFiles.clear();

					console.log(
						`\n📝 Changes detected (${changedPaths.length} file${changedPaths.length !== 1 ? "s" : ""})`,
					);

					// Sync only changed files
					const watchResult = await this.syncService.sync({
						...syncOptions,
						paths: changedPaths,
						dryRun: false, // Watch mode always applies changes
					});

					const hasChanges =
						watchResult.added > 0 ||
						watchResult.updated > 0 ||
						watchResult.deleted > 0;

					if (hasChanges) {
						console.log(
							`   ✅ Synced: +${watchResult.added} ~${watchResult.updated} -${watchResult.deleted}`,
						);

						if (watchResult.errors.length > 0) {
							console.log(
								`   ❌ Errors: ${watchResult.errors.map((e) => e.path).join(", ")}`,
							);
						}

						// Show cascade warnings in watch mode
						if (
							watchResult.cascadeWarnings &&
							watchResult.cascadeWarnings.length > 0
						) {
							console.log(
								`   ⚠️  Cascade impacts detected: ${watchResult.cascadeWarnings.length} warning(s)`,
							);
						}
					} else {
						console.log("   ⏭️  No changes detected");
					}

					console.log("⏳ Watching for changes...\n");
				} catch (error) {
					console.error(
						`   ❌ Sync failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					console.log("⏳ Watching for changes...\n");
				}
			}, 500); // 500ms debounce window
		};

		// Set up file watcher
		console.log("\n👁️  Watch mode enabled\n");
		this.watcher = watch(docsPath, { recursive: true }, (event, filename) => {
			// Only watch markdown files
			if (filename?.endsWith(".md")) {
				const fullPath = join(docsPath, filename);
				trackedFiles.add(fullPath);
				debouncedSync();
			}
		});

		// Handle graceful shutdown on SIGINT (Ctrl+C)
		process.on("SIGINT", () => {
			this.shutdown().catch(console.error);
		});

		// Keep the process running (never resolves)
		await new Promise(() => {});
	}

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		console.log("\n\n👋 Stopping watch mode...");

		if (this.watcher) {
			this.watcher.close();
		}

		await this.safeExit(0);
	}

	private printSyncResults(result: SyncResult, isWatchMode = false): void {
		console.log("\n📊 Sync Results:\n");
		console.log(`  ✅ Added: ${result.added}`);
		console.log(`  🔄 Updated: ${result.updated}`);
		console.log(`  🗑️  Deleted: ${result.deleted}`);
		console.log(`  ⏭️  Unchanged: ${result.unchanged}`);
		if (result.embeddingsGenerated > 0) {
			console.log(`  🧠 Embeddings: ${result.embeddingsGenerated}`);
		}
		console.log(`  ⏱️  Duration: ${result.duration}ms`);

		if (result.errors.length > 0) {
			console.log(`\n❌ Errors (${result.errors.length}):\n`);
			result.errors.forEach((e) => {
				console.log(`  ${e.path}: ${e.error}`);
			});
		}

		if (result.changes && result.changes.length > 0) {
			// Filter out unchanged items
			const actualChanges = result.changes.filter(
				(c: DocumentChange) => c.changeType !== "unchanged",
			);

			if (actualChanges.length > 0) {
				console.log("\n📝 Changes:\n");
				const icons: Record<ChangeType, string> = {
					new: "➕",
					updated: "🔄",
					deleted: "🗑️",
					unchanged: "⏭️",
				};
				actualChanges.forEach((c: DocumentChange) => {
					const icon = icons[c.changeType];
					console.log(`  ${icon} ${c.changeType}: ${c.path}`);
					if (c.reason) {
						console.log(`     ${c.reason}`);
					}
				});
			}
		}

		// Display cascade impact warnings
		if (result.cascadeWarnings && result.cascadeWarnings.length > 0) {
			console.log("\n⚠️  Cascade Impacts Detected:\n");

			// Group by trigger type for clarity
			const warningsByTrigger = new Map<
				string,
				(typeof result.cascadeWarnings)[number][]
			>();
			for (const warning of result.cascadeWarnings) {
				const existing = warningsByTrigger.get(warning.trigger) || [];
				existing.push(warning);
				warningsByTrigger.set(warning.trigger, existing);
			}

			for (const [trigger, warnings] of warningsByTrigger) {
				const triggerLabel = trigger
					.split("_")
					.map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
					.join(" ");
				console.log(`  📌 ${triggerLabel}\n`);

				for (const analysis of warnings) {
					console.log(`    ${analysis.summary}`);
					console.log(`    Source: ${analysis.sourceDocument}\n`);

					if (analysis.affectedDocuments.length > 0) {
						for (const affected of analysis.affectedDocuments) {
							const icon =
								affected.confidence === "high"
									? "🔴"
									: affected.confidence === "medium"
										? "🟡"
										: "🟢";
							console.log(
								`      ${icon} [${affected.confidence.toUpperCase()}] ${affected.path}`,
							);
							console.log(`         ${affected.reason}`);
							const suggestedAction = affected.suggestedAction
								.split("_")
								.join(" ")
								.replace(/\b\w/g, (char: string) => char.toUpperCase());
							console.log(`         → ${suggestedAction}`);
						}
					} else {
						console.log(`      ℹ️  No directly affected documents detected`);
					}
					console.log();
				}
			}

			console.log("  💡 Run /update-related to apply suggested changes\n");
		}

		if (isWatchMode) {
			console.log("\n⏳ Watching for changes... (Ctrl+C to stop)\n");
		}
	}

	@Option({
		flags: "-f, --force",
		description:
			"Force re-sync specified documents (requires paths to be specified)",
	})
	parseForce(): boolean {
		return true;
	}

	@Option({
		flags: "-d, --dry-run",
		description: "Show what would change without applying",
	})
	parseDryRun(): boolean {
		return true;
	}

	@Option({
		flags: "-v, --verbose",
		description: "Show detailed output",
	})
	parseVerbose(): boolean {
		return true;
	}

	@Option({
		flags: "-w, --watch",
		description: "Watch for file changes and sync automatically",
	})
	parseWatch(): boolean {
		return true;
	}

	@Option({
		flags: "--diff",
		description: "Show only changed documents (alias for --dry-run)",
	})
	parseDiff(): boolean {
		return true;
	}

	@Option({
		flags: "--skip-cascade",
		description: "Skip cascade analysis (faster for large repos)",
	})
	parseSkipCascade(): boolean {
		return true;
	}

	@Option({
		flags: "--no-embeddings",
		description: "Disable embedding generation during sync",
	})
	parseNoEmbeddings(): boolean {
		return false;
	}

	@Option({
		flags: "--skip-extraction",
		description:
			"Skip AI entity extraction (sync without re-extracting entities)",
	})
	parseSkipExtraction(): boolean {
		return true;
	}
}
