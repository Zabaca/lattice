import { Command } from 'commander';
import { NestFactory } from '@nestjs/core';
import { watch } from 'fs';
import { join } from 'path';
import { AppModule } from '../app.module.js';
import { SyncService, SyncOptions } from '../sync/sync.service.js';

export function registerSyncCommand(program: Command) {
	program
		.command('sync [paths...]')
		.description('Synchronize documents to the knowledge graph')
		.option('-f, --force', 'Force re-sync: with paths, clears only those docs; without paths, rebuilds entire graph')
		.option('-d, --dry-run', 'Show what would change without applying')
		.option('-v, --verbose', 'Show detailed output')
		.option('-w, --watch', 'Watch for file changes and sync automatically')
		.option('--diff', 'Show only changed documents (alias for --dry-run)')
		.option('--skip-cascade', 'Skip cascade analysis (faster for large repos)')
		.option('--no-embeddings', 'Disable embedding generation during sync')
		.action(async (paths: string[], options) => {
			let app;
			let watcher: ReturnType<typeof watch> | null = null;
			let isShuttingDown = false;

			/**
			 * Helper function to print sync results
			 */
			const printSyncResults = (result: any, isWatchMode = false) => {
				// Print results
				console.log('\n📊 Sync Results:\n');
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
					result.errors.forEach((e: any) => {
						console.log(`  ${e.path}: ${e.error}`);
					});
				}

				if (options.verbose && result.changes.length > 0) {
					console.log('\n📝 Changes:\n');
					result.changes.forEach((c: any) => {
						const icon = {
							new: '➕',
							updated: '🔄',
							deleted: '🗑️',
							unchanged: '⏭️',
						}[c.changeType];
						console.log(`  ${icon} ${c.changeType}: ${c.path}`);
						if (c.reason) {
							console.log(`     ${c.reason}`);
						}
					});
				}

				// Display cascade impact warnings
				if (result.cascadeWarnings && result.cascadeWarnings.length > 0) {
					console.log('\n⚠️  Cascade Impacts Detected:\n');

					// Group by trigger type for clarity
					const warningsByTrigger = new Map<string, any[]>();
					for (const warning of result.cascadeWarnings) {
						const existing = warningsByTrigger.get(warning.trigger) || [];
						existing.push(warning);
						warningsByTrigger.set(warning.trigger, existing);
					}

					for (const [trigger, warnings] of warningsByTrigger) {
						const triggerLabel = trigger
							.split('_')
							.map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
							.join(' ');
						console.log(`  📌 ${triggerLabel}\n`);

						for (const analysis of warnings) {
							console.log(`    ${analysis.summary}`);
							console.log(`    Source: ${analysis.sourceDocument}\n`);

							if (analysis.affectedDocuments.length > 0) {
								for (const affected of analysis.affectedDocuments) {
									const icon =
										affected.confidence === 'high'
											? '🔴'
											: affected.confidence === 'medium'
												? '🟡'
												: '🟢';
									console.log(
										`      ${icon} [${affected.confidence.toUpperCase()}] ${affected.path}`
									);
									console.log(`         ${affected.reason}`);
									const suggestedAction = affected.suggestedAction
										.split('_')
										.join(' ')
										.replace(/\b\w/g, (char: string) => char.toUpperCase());
									console.log(`         → ${suggestedAction}`);
								}
							} else {
								console.log(`      ℹ️  No directly affected documents detected`);
							}
							console.log();
						}
					}

					console.log('  💡 Run /update-related to apply suggested changes\n');
				}

				if (isWatchMode) {
					console.log('\n⏳ Watching for changes... (Ctrl+C to stop)\n');
				}
			};

			/**
			 * Helper function to handle graceful shutdown
			 */
			const shutdown = async () => {
				if (isShuttingDown) return;
				isShuttingDown = true;

				console.log('\n\n👋 Stopping watch mode...');

				if (watcher) {
					watcher.close();
				}

				if (app) {
					await app.close();
				}

				process.exit(0);
			};

			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: options.verbose ? ['log', 'error', 'warn'] : false,
				});
				const sync = app.get(SyncService);

				// Watch mode is incompatible with dry-run
				if (options.watch && options.dryRun) {
					console.log(
						'\n⚠️  Watch mode is not compatible with --dry-run mode\n'
					);
					await app.close();
					process.exit(1);
				}

				// Watch mode is incompatible with force mode (for safety)
				if (options.watch && options.force) {
					console.log(
						'\n⚠️  Watch mode is not compatible with --force mode (for safety)\n'
					);
					await app.close();
					process.exit(1);
				}

				const syncOptions: SyncOptions = {
					force: options.force,
					dryRun: options.dryRun || options.diff,
					verbose: options.verbose,
					paths: paths.length > 0 ? paths : undefined,
					skipCascade: options.skipCascade,
					embeddings: options.embeddings !== false, // Default true, --no-embeddings sets to false
				};

				console.log('\n🔄 Graph Sync\n');

				if (syncOptions.force) {
					if (syncOptions.paths && syncOptions.paths.length > 0) {
						console.log(`⚠️  Force mode: ${syncOptions.paths.length} document(s) will be cleared and re-synced\n`);
					} else {
						console.log('⚠️  Force mode: Entire graph will be cleared and rebuilt\n');
					}
				}

				if (syncOptions.dryRun) {
					console.log('📋 Dry run mode: No changes will be applied\n');
				}

				if (syncOptions.skipCascade) {
					console.log('⚡ Cascade analysis skipped\n');
				}

				if (!syncOptions.embeddings) {
					console.log('🚫 Embedding generation disabled\n');
				}

				if (syncOptions.paths) {
					console.log(
						`📁 Syncing specific paths: ${syncOptions.paths.join(', ')}\n`
					);
				}

				// Initial sync
				const initialResult = await sync.sync(syncOptions);
				printSyncResults(initialResult, options.watch);

				if (options.dryRun) {
					console.log('💡 Run without --dry-run to apply changes');
				}

				// Enter watch mode if requested
				if (options.watch) {
					const docsPath = process.env.DOCS_PATH || 'docs';

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
							if (isShuttingDown) return;

							if (trackedFiles.size === 0) return;

							try {
								const changedPaths = Array.from(trackedFiles);
								trackedFiles.clear();

								console.log(
									`\n📝 Changes detected (${changedPaths.length} file${changedPaths.length !== 1 ? 's' : ''})`
								);

								// Sync only changed files
								const watchResult = await sync.sync({
									...syncOptions,
									paths: changedPaths,
									dryRun: false, // Watch mode always applies changes
								});

								const hasChanges =
									watchResult.added > 0 ||
									watchResult.updated > 0 ||
									watchResult.deleted > 0;

								if (hasChanges) {
									console.log(`   ✅ Synced: +${watchResult.added} ~${watchResult.updated} -${watchResult.deleted}`);

									if (watchResult.errors.length > 0) {
										console.log(
											`   ❌ Errors: ${watchResult.errors.map((e: any) => e.path).join(', ')}`
										);
									}

									// Show cascade warnings in watch mode
									if (watchResult.cascadeWarnings && watchResult.cascadeWarnings.length > 0) {
										console.log(`   ⚠️  Cascade impacts detected: ${watchResult.cascadeWarnings.length} warning(s)`);
									}
								} else {
									console.log('   ⏭️  No changes detected');
								}

								console.log('⏳ Watching for changes...\n');
							} catch (error) {
								console.error(
									`   ❌ Sync failed: ${error instanceof Error ? error.message : String(error)}`
								);
								console.log('⏳ Watching for changes...\n');
							}
						}, 500); // 500ms debounce window
					};

					// Set up file watcher
					console.log('\n👁️  Watch mode enabled\n');
					watcher = watch(docsPath, { recursive: true }, (event, filename) => {
						// Only watch markdown files
						if (filename && filename.endsWith('.md')) {
							const fullPath = join(docsPath, filename);
							trackedFiles.add(fullPath);
							debouncedSync();
						}
					});

					// Handle graceful shutdown on SIGINT (Ctrl+C)
					process.on('SIGINT', shutdown);

					// Keep the process running (never resolves)
					await new Promise(() => {});
				} else {
					// Non-watch mode: close and exit normally
					await app.close();
					process.exit(initialResult.errors.length > 0 ? 1 : 0);
				}
			} catch (error) {
				console.error(
					'\n❌ Sync failed:',
					error instanceof Error ? error.message : String(error)
				);
				if (app) await app.close();
				process.exit(1);
			}
		});
}
