import { Injectable, Logger } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { GraphService } from "../graph/graph.service.js";
import { ManifestService } from "../sync/manifest.service.js";
import { SyncService } from "../sync/sync.service.js";

interface MigrateCommandOptions {
	dryRun?: boolean;
	verbose?: boolean;
	skipSync?: boolean;
}

/**
 * Migration command for upgrading from v1 (manifest-based) to v2 (database-based).
 *
 * What it does:
 * 1. Applies v2 schema changes (adds content_hash, embedding_source_hash columns)
 * 2. Migrates existing manifest hashes to the database
 * 3. Runs a full sync with AI entity extraction
 *
 * After migration:
 * - Database becomes source of truth for change detection
 * - AI extraction replaces frontmatter entity parsing
 * - Manifest file can be safely deleted
 */
@Injectable()
@Command({
	name: "migrate",
	description: "Migrate from v1 (manifest) to v2 (database-based) architecture",
})
export class MigrateCommand extends CommandRunner {
	private readonly logger = new Logger(MigrateCommand.name);

	constructor(
		private readonly graph: GraphService,
		private readonly manifest: ManifestService,
		private readonly syncService: SyncService,
	) {
		super();
	}

	async run(
		_passedParams: string[],
		options: MigrateCommandOptions,
	): Promise<void> {
		console.log("\n🔄 Migrating to Lattice v2...\n");

		if (options.dryRun) {
			console.log("📋 Dry run mode: No changes will be applied\n");
		}

		try {
			// Step 1: Apply v2 schema changes
			console.log("📦 Step 1/3: Applying v2 schema changes...");
			if (!options.dryRun) {
				await this.graph.runV2Migration();
				console.log(
					"   ✅ Schema updated with content_hash and embedding_source_hash columns\n",
				);
			} else {
				console.log(
					"   [DRY-RUN] Would add content_hash and embedding_source_hash columns\n",
				);
			}

			// Step 2: Migrate manifest hashes to database
			console.log("📋 Step 2/3: Migrating manifest hashes to database...");
			const manifestStats = await this.migrateManifestHashes(options);
			if (manifestStats.total > 0) {
				if (!options.dryRun) {
					console.log(
						`   ✅ Migrated ${manifestStats.migrated}/${manifestStats.total} document hashes\n`,
					);
				} else {
					console.log(
						`   [DRY-RUN] Would migrate ${manifestStats.total} document hashes\n`,
					);
				}
			} else {
				console.log(
					"   ℹ️  No manifest found or manifest is empty (fresh install)\n",
				);
			}

			// Step 3: Run full sync with AI extraction
			if (!options.skipSync) {
				console.log(
					"🤖 Step 3/3: Running full sync with AI entity extraction...",
				);
				console.log(
					"   This may take a while depending on the number of documents...\n",
				);

				if (!options.dryRun) {
					const result = await this.syncService.sync({
						force: false, // Don't force - let change detection handle it
						aiExtraction: true,
						verbose: options.verbose,
						embeddings: true,
					});

					console.log("\n📊 Sync Results:");
					console.log(`   ✅ Added: ${result.added}`);
					console.log(`   🔄 Updated: ${result.updated}`);
					console.log(`   🗑️  Deleted: ${result.deleted}`);
					console.log(`   ⏭️  Unchanged: ${result.unchanged}`);
					if (result.errors.length > 0) {
						console.log(`   ❌ Errors: ${result.errors.length}`);
						for (const err of result.errors) {
							console.log(`      ${err.path}: ${err.error}`);
						}
					}
					console.log(`   ⏱️  Duration: ${result.duration}ms\n`);
				} else {
					console.log("   [DRY-RUN] Would run full sync with AI extraction\n");
				}
			} else {
				console.log("⏭️  Step 3/3: Skipping sync (--skip-sync flag)\n");
			}

			// Success message
			console.log("✅ Migration complete!\n");
			console.log("Next steps:");
			console.log("  1. Verify your graph: lattice status");
			console.log("  2. Test semantic search: lattice search <query>");
			console.log("  3. Future syncs will use v2 mode automatically");
			console.log(
				"  4. Optional: Delete ~/.lattice/.sync-manifest.json (no longer needed)\n",
			);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(`\n❌ Migration failed: ${errorMsg}\n`);
			this.logger.error(
				`Migration failed: ${errorMsg}`,
				error instanceof Error ? error.stack : undefined,
			);
			process.exit(1);
		}
	}

	/**
	 * Migrate manifest document hashes to database.
	 * Returns stats about how many were migrated.
	 */
	private async migrateManifestHashes(
		options: MigrateCommandOptions,
	): Promise<{ total: number; migrated: number; skipped: number }> {
		const stats = { total: 0, migrated: 0, skipped: 0 };

		try {
			const manifestData = await this.manifest.load();
			const entries = Object.entries(manifestData.documents);
			stats.total = entries.length;

			if (stats.total === 0) {
				return stats;
			}

			for (const [path, entry] of entries) {
				if (options.verbose) {
					console.log(`   Processing: ${path}`);
				}

				if (!options.dryRun) {
					try {
						// Update database with manifest hash
						await this.graph.updateDocumentHashes(path, entry.contentHash);
						stats.migrated++;
					} catch (error) {
						// Document may not exist in graph yet - that's OK, sync will create it
						stats.skipped++;
						if (options.verbose) {
							const errorMsg =
								error instanceof Error ? error.message : String(error);
							console.log(`   ⚠️  Skipped ${path}: ${errorMsg}`);
						}
					}
				} else {
					stats.migrated++;
				}
			}
		} catch (error) {
			// Manifest doesn't exist - that's fine for fresh installs
			if (options.verbose) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.logger.debug(`No manifest to migrate: ${errorMsg}`);
			}
		}

		return stats;
	}

	@Option({
		flags: "--dry-run",
		description: "Show what would be done without making changes",
	})
	parseDryRun(): boolean {
		return true;
	}

	@Option({
		flags: "-v, --verbose",
		description: "Show detailed progress",
	})
	parseVerbose(): boolean {
		return true;
	}

	@Option({
		flags: "--skip-sync",
		description:
			"Skip the full sync step (only apply schema and migrate hashes)",
	})
	parseSkipSync(): boolean {
		return true;
	}
}
