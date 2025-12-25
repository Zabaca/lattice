import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { getLatticeHome } from "../utils/paths.js";

interface SiteCommandOptions {
	build?: boolean;
	dev?: boolean;
	kill?: boolean;
	port?: string;
}

@Injectable()
@Command({
	name: "site",
	description: "Build and run the Lattice documentation site",
})
export class SiteCommand extends CommandRunner {
	private getPidFile(): string {
		return path.join(getLatticeHome(), "site.pid");
	}

	async run(_inputs: string[], options: SiteCommandOptions): Promise<void> {
		// Handle --kill flag
		if (options.kill) {
			this.killSiteProcess();
			process.exit(0);
		}

		const latticeHome = getLatticeHome();
		const packageJsonPath = path.join(latticeHome, "package.json");
		const nodeModulesPath = path.join(latticeHome, "node_modules");

		// Check if site is initialized
		if (!existsSync(packageJsonPath)) {
			console.error("Error: Site not initialized. Run 'lattice init' first.");
			process.exit(1);
		}

		// Check if a site is already running
		if (this.isRunning()) {
			console.error("Error: A Lattice site is already running.");
			console.error("Use 'lattice site --kill' to stop it first.");
			process.exit(1);
		}

		// Check if node_modules exists, if not install dependencies
		if (!existsSync(nodeModulesPath)) {
			console.log("📦 Installing dependencies...");
			await this.runCommand("bun", ["install"], latticeHome);
			console.log();
		}

		// If --build flag, just build and exit
		if (options.build) {
			console.log("🔨 Building site...");
			await this.runCommand("bun", ["run", "build"], latticeHome);
			console.log("\n✅ Build complete! Output in: ~/.lattice/dist/");
			process.exit(0);
		}

		// If --dev flag, run dev server (no build needed)
		if (options.dev) {
			console.log("🚀 Starting dev server...");
			const port = options.port || "4321";
			await this.runServerCommand(
				"bun",
				["run", "dev", "--", "--port", port],
				latticeHome,
			);
			process.exit(0);
		}

		// Default: Build then preview
		console.log("🔨 Building site with search index...");
		await this.runCommand("bun", ["run", "build"], latticeHome);

		console.log("\n🚀 Starting preview server...");
		const port = options.port || "4321";
		await this.runServerCommand(
			"bun",
			["run", "preview", "--", "--port", port],
			latticeHome,
		);
	}

	private runCommand(
		cmd: string,
		args: string[],
		cwd: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(cmd, args, {
				cwd,
				stdio: "pipe",
				env: { ...process.env, FORCE_COLOR: "1" },
			});

			child.stdout?.on("data", (data) => {
				process.stdout.write(data);
			});
			child.stderr?.on("data", (data) => {
				process.stderr.write(data);
			});

			child.on("close", (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Command failed with code ${code}`));
				}
			});

			child.on("error", (err) => {
				reject(err);
			});
		});
	}

	private runServerCommand(
		cmd: string,
		args: string[],
		cwd: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(cmd, args, {
				cwd,
				stdio: "inherit",
				env: { ...process.env, FORCE_COLOR: "1" },
			});

			// Write PID to file
			if (child.pid) {
				writeFileSync(this.getPidFile(), String(child.pid));
			}

			// Clean up PID file on exit
			const cleanup = () => {
				try {
					unlinkSync(this.getPidFile());
				} catch {
					// Ignore if file doesn't exist
				}
			};

			child.on("close", (code) => {
				cleanup();
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Command failed with code ${code}`));
				}
			});

			child.on("error", (err) => {
				cleanup();
				reject(err);
			});

			// Also clean up on parent process signals
			process.on("SIGINT", cleanup);
			process.on("SIGTERM", cleanup);
		});
	}

	private isRunning(): boolean {
		const pidFile = this.getPidFile();
		if (!existsSync(pidFile)) {
			return false;
		}

		try {
			const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			// Check if process is still running by sending signal 0
			process.kill(pid, 0);
			return true;
		} catch {
			// Process not running, clean up stale PID file
			try {
				unlinkSync(pidFile);
			} catch {
				// Ignore
			}
			return false;
		}
	}

	private killSiteProcess(): void {
		const pidFile = this.getPidFile();

		if (!existsSync(pidFile)) {
			console.log("No Lattice site process running");
			return;
		}

		try {
			const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

			// Kill the process group (negative PID kills the group)
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// Try killing just the process if group kill fails
				process.kill(pid, "SIGTERM");
			}

			// Clean up PID file
			unlinkSync(pidFile);
			console.log(`✅ Killed Lattice site process (PID: ${pid})`);
		} catch (err) {
			// Process might already be dead, clean up PID file
			try {
				unlinkSync(pidFile);
			} catch {
				// Ignore
			}
			console.log("No Lattice site process running");
		}
	}

	@Option({
		flags: "-b, --build",
		description: "Build the site without starting the server",
	})
	parseBuild(): boolean {
		return true;
	}

	@Option({
		flags: "-d, --dev",
		description: "Run in development mode (hot reload, no search)",
	})
	parseDev(): boolean {
		return true;
	}

	@Option({
		flags: "-p, --port <port>",
		description: "Port to run the server on (default: 4321)",
	})
	parsePort(val: string): string {
		return val;
	}

	@Option({
		flags: "-k, --kill",
		description: "Kill the running Lattice site process",
	})
	parseKill(): boolean {
		return true;
	}
}
