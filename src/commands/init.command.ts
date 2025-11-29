import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMMANDS = ['research.md', 'graph-sync.md', 'entity-extract.md'];

interface InitCommandOptions {
	global?: boolean;
}

@Injectable()
@Command({
	name: 'init',
	description: 'Install Claude Code slash commands for Lattice',
})
export class InitCommand extends CommandRunner {
	async run(_inputs: string[], options: InitCommandOptions): Promise<void> {
		try {
			// Determine target directory
			const targetDir = options.global
				? path.join(homedir(), '.claude', 'commands')
				: path.join(process.cwd(), '.claude', 'commands');

			// Find commands source directory
			// In built package: dist/cli.js -> commands/ is at package root (one level up)
			// In dev: src/commands/init.command.ts -> commands/ is at package root (two levels up)
			// Try both paths
			let commandsSourceDir = path.resolve(__dirname, '..', 'commands');
			try {
				await fs.access(commandsSourceDir);
			} catch {
				// Fall back to dev path (two levels up)
				commandsSourceDir = path.resolve(__dirname, '..', '..', 'commands');
			}

			// Verify source directory exists
			try {
				await fs.access(commandsSourceDir);
			} catch {
				console.error('Error: Commands source directory not found at', commandsSourceDir);
				console.error('This may indicate a corrupted installation. Try reinstalling @zabaca/lattice.');
				process.exit(1);
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
					// Check if source exists
					await fs.access(sourcePath);

					// Check if target already exists
					try {
						await fs.access(targetPath);
						// File exists - check if it's different
						const sourceContent = await fs.readFile(sourcePath, 'utf-8');
						const targetContent = await fs.readFile(targetPath, 'utf-8');

						if (sourceContent === targetContent) {
							skipped++;
							continue;
						}
					} catch {
						// Target doesn't exist, will copy
					}

					// Copy the file
					await fs.copyFile(sourcePath, targetPath);
					installed.push(file);
					copied++;
				} catch (err) {
					console.error(`Warning: Could not copy ${file}:`, err instanceof Error ? err.message : String(err));
				}
			}

			// Report results
			console.log();
			console.log(`✅ Lattice commands installed to ${targetDir}`);
			console.log();

			if (copied > 0) {
				console.log(`Installed ${copied} command(s):`);
				installed.forEach((f) => {
					const name = f.replace('.md', '');
					console.log(`  - /${name}`);
				});
			}

			if (skipped > 0) {
				console.log(`Skipped ${skipped} unchanged command(s)`);
			}

			console.log();
			console.log('Available commands in Claude Code:');
			console.log('  /research <topic>    - AI-assisted research workflow');
			console.log('  /graph-sync          - Extract entities and sync to graph');
			console.log('  /entity-extract      - Extract entities from a single document');
			console.log();

			if (!options.global) {
				console.log("💡 Tip: Use 'lattice init --global' to install for all projects");
			}

			process.exit(0);
		} catch (error) {
			console.error(
				'Error:',
				error instanceof Error ? error.message : String(error)
			);
			process.exit(1);
		}
	}

	@Option({
		flags: '-g, --global',
		description: 'Install to ~/.claude/commands/ (available in all projects)',
	})
	parseGlobal(): boolean {
		return true;
	}
}
