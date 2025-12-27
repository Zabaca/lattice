import { spawn } from "node:child_process";
import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { SyncService } from "../sync/sync.service.js";
import { ensureCroc } from "../utils/croc-binary.js";
import { getDocsPath } from "../utils/paths.js";

interface ReceiveCommandOptions {
	noSync?: boolean;
}

@Injectable()
@Command({
	name: "receive",
	arguments: "<code>",
	description: "Receive shared documents via P2P transfer",
})
export class ReceiveCommand extends CommandRunner {
	constructor(private readonly syncService: SyncService) {
		super();
	}

	async run([code]: string[], options: ReceiveCommandOptions): Promise<void> {
		if (!code) {
			console.error("\n❌ Please specify a share code\n");
			console.error("Usage: lattice receive <code>\n");
			console.error("Example:");
			console.error("  lattice receive 7-actress-plural-pilgrim\n");
			process.exit(1);
		}

		const docsDir = getDocsPath();

		console.log(`\n📥 Receiving files to: ${docsDir}\n`);

		// Ensure croc binary is available (auto-download if needed)
		const crocPath = await ensureCroc();

		// Run croc receive with --yes to auto-accept and --out to specify destination
		// Use --classic mode to allow passing code as argument (new secure mode requires env var)
		const receiveCode = await new Promise<number>((resolve, reject) => {
			const child = spawn(
				crocPath,
				["--classic", "--yes", "--out", docsDir, code],
				{
					stdio: "inherit",
				},
			);

			child.on("close", (code) => {
				resolve(code ?? 0);
			});

			child.on("error", (err) => {
				reject(err);
			});
		});

		if (receiveCode !== 0) {
			console.error("\n❌ Transfer failed\n");
			process.exit(receiveCode);
		}

		// Run sync unless --no-sync was specified
		if (!options.noSync) {
			console.log("\n🔄 Syncing received documents to knowledge graph...\n");

			try {
				const result = await this.syncService.sync({
					verbose: false,
				});

				console.log("📊 Sync Results:\n");
				console.log(`  ✅ Added: ${result.added}`);
				console.log(`  🔄 Updated: ${result.updated}`);
				console.log(`  ⏭️  Unchanged: ${result.unchanged}`);
				if (result.embeddingsGenerated > 0) {
					console.log(`  🧠 Embeddings: ${result.embeddingsGenerated}`);
				}

				if (result.errors.length > 0) {
					console.log(`\n❌ Errors (${result.errors.length}):\n`);
					result.errors.forEach((e) => {
						console.log(`  ${e.path}: ${e.error}`);
					});
				}
			} catch (error) {
				console.error(
					`\n⚠️  Sync failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				console.error(
					"Files were received but not synced to the knowledge graph.",
				);
				console.error("Run 'lattice sync' manually to complete sync.\n");
			}
		} else {
			console.log("\n⏭️  Skipping sync (--no-sync specified)");
			console.log(
				"Run 'lattice sync' to add documents to the knowledge graph.\n",
			);
		}

		console.log("✅ Done!\n");
	}

	@Option({
		flags: "--no-sync",
		description: "Skip running lattice sync after receiving",
	})
	parseNoSync(): boolean {
		return true;
	}
}
