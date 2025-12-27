import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { Injectable } from "@nestjs/common";
import { Command, CommandRunner } from "nest-commander";
import { ensureCroc } from "../utils/croc-binary.js";
import { getDocsPath } from "../utils/paths.js";

@Injectable()
@Command({
	name: "share",
	arguments: "<path>",
	description: "Share a document or topic directory via P2P transfer",
})
export class ShareCommand extends CommandRunner {
	async run([docPath]: string[]): Promise<void> {
		if (!docPath) {
			console.error("\n❌ Please specify a path to share\n");
			console.error("Usage: lattice share <path>\n");
			console.error("Examples:");
			console.error(
				"  lattice share duckdb                  # Share ~/.lattice/docs/duckdb/",
			);
			console.error(
				"  lattice share duckdb/README.md        # Share single file\n",
			);
			process.exit(1);
		}

		// Resolve path - relative to ~/.lattice/docs/ or absolute
		const fullPath = this.resolvePath(docPath);

		// Validate path exists
		if (!existsSync(fullPath)) {
			console.error(`\n❌ Path not found: ${fullPath}\n`);
			process.exit(1);
		}

		const stat = statSync(fullPath);
		const isDir = stat.isDirectory();

		console.log(`\n📤 Sharing ${isDir ? "directory" : "file"}: ${fullPath}\n`);

		// Ensure croc binary is available (auto-download if needed)
		const crocPath = await ensureCroc();

		// Spawn croc send with piped output to filter it
		// Global flags come before the command in croc
		const child = spawn(crocPath, ["--disable-clipboard", "send", fullPath], {
			stdio: ["inherit", "pipe", "pipe"],
		});

		let codeExtracted = false;
		let outputBuffer = "";

		const handleOutput = (data: Buffer) => {
			const text = data.toString();
			outputBuffer += text;

			// Wait until we have the code before showing anything
			if (!codeExtracted) {
				const codeMatch = outputBuffer.match(/Code is:\s*(\S+)/);
				if (codeMatch) {
					codeExtracted = true;
					const code = codeMatch[1];

					// Extract the "Sending N files" line from buffer
					// Find all matches and take the last one (croc updates as it counts)
					// Matches: "Sending 2 files and 1 folders (4.9 kB)"
					const sendingMatches = outputBuffer.match(
						/Sending \d+ files? (?:and \d+ folders? )?\([^)]+\)/g,
					);
					if (sendingMatches && sendingMatches.length > 0) {
						// Get last match (final count)
						const lastMatch = sendingMatches[sendingMatches.length - 1];
						// Only show if not "0 files"
						if (!lastMatch.includes("0 files")) {
							console.log(lastMatch);
						}
					}

					// Print our own Lattice-specific message
					console.log(`\n🔗 Share code: ${code}\n`);
					console.log("On the receiving machine, run:");
					console.log(`  lattice receive ${code}\n`);
					console.log("Waiting for recipient...\n");

					// Clear buffer after processing
					outputBuffer = "";
				}
				return;
			}

			// After code is extracted, filter croc's helper text
			if (
				text.includes("On the other computer") ||
				text.includes("(For Windows)") ||
				text.includes("(For Linux/macOS)") ||
				text.includes("CROC_SECRET=") ||
				text.includes("Code copied to clipboard") ||
				text.includes("croc ")
			) {
				return;
			}

			// Show progress and transfer output
			process.stdout.write(text);
		};

		child.stdout?.on("data", handleOutput);
		child.stderr?.on("data", handleOutput);

		child.on("close", (code) => {
			if (code === 0) {
				console.log("\n✅ Transfer complete!\n");
			}
			process.exit(code ?? 0);
		});

		child.on("error", (err) => {
			console.error(`\n❌ Failed to run croc: ${err.message}\n`);
			process.exit(1);
		});
	}

	/**
	 * Resolve a document path - relative to ~/.lattice/docs/ or absolute
	 */
	private resolvePath(input: string): string {
		// If absolute path, use as-is
		if (path.isAbsolute(input)) {
			return input;
		}

		// Otherwise, resolve relative to docs dir
		const docsDir = getDocsPath();
		return path.join(docsDir, input);
	}
}
