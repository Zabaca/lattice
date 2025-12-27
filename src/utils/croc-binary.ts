/**
 * @fileoverview Croc binary manager for P2P file sharing
 *
 * Auto-downloads the croc binary on first use and stores it in ~/.lattice/bin/
 * Supports macOS (arm64/x64), Linux (arm64/x64), and Windows (x64)
 */

import { execSync } from "node:child_process";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getLatticeHome } from "./paths.js";

const CROC_VERSION = "10.3.1";

/**
 * Get the directory where croc binary is stored
 */
export function getBinPath(): string {
	return join(getLatticeHome(), "bin");
}

/**
 * Get the full path to the croc binary
 */
export function getCrocPath(): string {
	const binName = process.platform === "win32" ? "croc.exe" : "croc";
	return join(getBinPath(), binName);
}

/**
 * Get the current bundled croc version
 */
export function getCrocVersion(): string {
	return CROC_VERSION;
}

/**
 * Map platform and architecture to croc release asset name
 */
function getAssetName(): string | null {
	const platform = process.platform;
	const arch = process.arch;

	const assetMap: Record<string, string> = {
		"darwin-arm64": "macOS-ARM64",
		"darwin-x64": "macOS-64bit",
		"linux-x64": "Linux-64bit",
		"linux-arm64": "Linux-ARM64",
		"win32-x64": "Windows-64bit",
	};

	const key = `${platform}-${arch}`;
	return assetMap[key] || null;
}

/**
 * Download and extract croc binary
 */
async function downloadCroc(): Promise<void> {
	const asset = getAssetName();
	if (!asset) {
		const key = `${process.platform}-${process.arch}`;
		console.error(`\n❌ Unsupported platform: ${key}`);
		console.error(
			"\nInstall croc manually: https://github.com/schollz/croc#install",
		);
		console.error("Then place the binary at: ~/.lattice/bin/croc\n");
		process.exit(1);
	}

	const binDir = getBinPath();
	if (!existsSync(binDir)) {
		mkdirSync(binDir, { recursive: true });
	}

	const ext = process.platform === "win32" ? "zip" : "tar.gz";
	const url = `https://github.com/schollz/croc/releases/download/v${CROC_VERSION}/croc_v${CROC_VERSION}_${asset}.${ext}`;

	console.log(`📥 Downloading croc v${CROC_VERSION}...`);

	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(
				`Failed to download: ${response.status} ${response.statusText}`,
			);
		}

		const crocPath = getCrocPath();

		if (ext === "tar.gz") {
			// For tar.gz, download and extract using native tar command
			const tempTarGz = join(binDir, "croc.tar.gz");
			const fileStream = createWriteStream(tempTarGz);

			// Write the response to a file
			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			fileStream.write(buffer);
			fileStream.end();

			// Wait for file to be written
			await new Promise<void>((resolve, reject) => {
				fileStream.on("finish", resolve);
				fileStream.on("error", reject);
			});

			// Extract using native tar command (available on macOS and Linux)
			execSync(`tar -xzf croc.tar.gz`, { cwd: binDir, stdio: "pipe" });

			// Clean up temp file
			unlinkSync(tempTarGz);

			// Make executable
			chmodSync(crocPath, 0o755);
		} else {
			// For Windows zip, show manual instructions
			console.error("\n❌ Windows auto-download not yet implemented.");
			console.error(
				"\nInstall croc manually: https://github.com/schollz/croc#install",
			);
			console.error("Then place the binary at: ~/.lattice/bin/croc.exe\n");
			process.exit(1);
		}

		console.log(`✅ Installed croc to ${crocPath}\n`);
	} catch (error) {
		console.error(
			`\n❌ Failed to download croc: ${error instanceof Error ? error.message : String(error)}`,
		);
		console.error(
			"\nInstall croc manually: https://github.com/schollz/croc#install",
		);
		console.error(`Then place the binary at: ${getCrocPath()}\n`);
		process.exit(1);
	}
}

/**
 * Ensure croc binary is available, downloading if necessary
 * @returns Path to the croc binary
 */
export async function ensureCroc(): Promise<string> {
	const crocPath = getCrocPath();

	if (existsSync(crocPath)) {
		return crocPath;
	}

	await downloadCroc();
	return crocPath;
}
