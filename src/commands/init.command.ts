import { existsSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Injectable } from "@nestjs/common";
import { Command, CommandRunner } from "nest-commander";
import {
	ensureLatticeHome,
	getDocsPath,
	getEnvPath,
	getLatticeHome,
} from "../utils/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMMANDS = ["research.md", "entity-extract.md"];

// Site template files to copy (relative paths from site-template/)
const SITE_TEMPLATE_FILES = [
	"astro.config.ts",
	"package.json",
	"tsconfig.json",
	"src/content.config.ts",
	"src/collections/authors.ts",
	"src/collections/documents.ts",
	"src/collections/tags.ts",
];

type InitCommandOptions = Record<string, never>;

@Injectable()
@Command({
	name: "init",
	description:
		"Initialize Lattice with Claude Code commands and site generator",
})
export class InitCommand extends CommandRunner {
	async run(_inputs: string[], _options: InitCommandOptions): Promise<void> {
		try {
			// Setup ~/.lattice/ directory structure
			ensureLatticeHome();

			const latticeHome = getLatticeHome();
			const envPath = getEnvPath();

			// Create .env file with placeholder if it doesn't exist
			if (!existsSync(envPath)) {
				writeFileSync(
					envPath,
					`# Lattice Configuration
# Get your API key from: https://www.voyageai.com/
VOYAGE_API_KEY=

# Site Configuration (for lattice site command)
SPACESHIP_AUTHOR="Lattice"
SPACESHIP_BASE="/"
SPACESHIP_SITE="https://example.com"
SPACESHIP_TITLE="Lattice"
SPACESHIP_DESCRIPTION="Research Knowledge Base"
OBSIDIAN_VAULT_DIR=docs
`,
				);
			} else {
				// Check if .env needs Spaceship config added
				const envContent = await fs.readFile(envPath, "utf-8");
				if (!envContent.includes("SPACESHIP_")) {
					await fs.appendFile(
						envPath,
						`
# Site Configuration (for lattice site command)
SPACESHIP_AUTHOR="Lattice"
SPACESHIP_BASE="/"
SPACESHIP_SITE="https://example.com"
SPACESHIP_TITLE="Lattice"
SPACESHIP_DESCRIPTION="Research Knowledge Base"
OBSIDIAN_VAULT_DIR=docs
`,
					);
					console.log("✅ Added site configuration to .env");
				}
			}

			// Show Lattice home setup info
			console.log(`✅ Lattice home directory: ${latticeHome}`);
			console.log(`   Documents: ${getDocsPath()}`);
			console.log(`   Config:    ${envPath}`);
			console.log();

			// Setup site template files
			await this.setupSiteTemplate(latticeHome);

			// Install Claude Code commands
			await this.installClaudeCommands();

			console.log();
			console.log("Available commands:");
			console.log(
				"  lattice site         - Build and run the documentation site",
			);
			console.log("  lattice sync         - Sync documents to knowledge graph");
			console.log("  lattice status       - Show documents needing sync");
			console.log("  lattice search       - Semantic search across documents");
			console.log();
			console.log("Claude Code slash commands:");
			console.log("  /research <topic>    - AI-assisted research workflow");
			console.log("  /entity-extract      - Extract entities from a document");
			console.log();
			console.log("Question tracking:");
			console.log("  lattice question:add <question>      - Add a question");
			console.log(
				"  lattice question:link <q> --doc <p>  - Link question to answer",
			);
			console.log(
				"  lattice question:unanswered          - List unanswered questions",
			);
			console.log();

			if (!(await fs.readFile(envPath, "utf-8")).includes("pa-")) {
				console.log(`⚠️  Add your Voyage API key to: ${envPath}`);
				console.log();
			}

			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	private async setupSiteTemplate(latticeHome: string): Promise<void> {
		// Find site-template directory
		// In built package: dist/commands/init.command.js -> site-template/ at package root
		// In dev: src/commands/init.command.ts -> site-template/ at package root
		let templateDir = path.resolve(__dirname, "..", "site-template");
		try {
			await fs.access(templateDir);
		} catch {
			// Fall back to package root (two levels up from src/commands)
			templateDir = path.resolve(__dirname, "..", "..", "site-template");
		}

		// Verify template directory exists
		try {
			await fs.access(templateDir);
		} catch {
			console.log("⚠️  Site template not found - skipping site setup");
			return;
		}

		// Create necessary directories
		await fs.mkdir(path.join(latticeHome, "src", "collections"), {
			recursive: true,
		});

		// Copy template files
		let copied = 0;
		let skipped = 0;

		for (const file of SITE_TEMPLATE_FILES) {
			const sourcePath = path.join(templateDir, file);
			const targetPath = path.join(latticeHome, file);

			try {
				await fs.access(sourcePath);

				// Check if target exists and is the same
				try {
					await fs.access(targetPath);
					const sourceContent = await fs.readFile(sourcePath, "utf-8");
					const targetContent = await fs.readFile(targetPath, "utf-8");
					if (sourceContent === targetContent) {
						skipped++;
						continue;
					}
				} catch {
					// Target doesn't exist, will copy
				}

				// Ensure parent directory exists
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.copyFile(sourcePath, targetPath);
				copied++;
			} catch (_err) {
				// Source file doesn't exist, skip
			}
		}

		if (copied > 0) {
			console.log(`✅ Site template: ${copied} file(s) installed`);
		}
		if (skipped > 0) {
			console.log(`   Site template: ${skipped} file(s) unchanged`);
		}
	}

	private async installClaudeCommands(): Promise<void> {
		// Always install to user's home directory
		const targetDir = path.join(homedir(), ".claude", "commands");

		// Find commands source directory
		let commandsSourceDir = path.resolve(__dirname, "..", "commands");
		try {
			await fs.access(commandsSourceDir);
		} catch {
			commandsSourceDir = path.resolve(__dirname, "..", "..", "commands");
		}

		// Verify source directory exists
		try {
			await fs.access(commandsSourceDir);
		} catch {
			console.log("⚠️  Claude commands not found - skipping");
			return;
		}

		// Create target directory
		await fs.mkdir(targetDir, { recursive: true });

		// Copy commands
		let copied = 0;
		let skipped = 0;
		const installed: string[] = [];

		for (const file of COMMANDS) {
			const sourcePath = path.join(commandsSourceDir, file);
			const targetPath = path.join(targetDir, file);

			try {
				await fs.access(sourcePath);

				try {
					await fs.access(targetPath);
					const sourceContent = await fs.readFile(sourcePath, "utf-8");
					const targetContent = await fs.readFile(targetPath, "utf-8");

					if (sourceContent === targetContent) {
						skipped++;
						continue;
					}
				} catch {
					// Target doesn't exist, will copy
				}

				await fs.copyFile(sourcePath, targetPath);
				installed.push(file);
				copied++;
			} catch (_err) {
				// Source doesn't exist, skip
			}
		}

		if (copied > 0) {
			console.log(`✅ Claude commands: ${copied} installed to ${targetDir}`);
		}
		if (skipped > 0) {
			console.log(`   Claude commands: ${skipped} unchanged`);
		}
	}
}
