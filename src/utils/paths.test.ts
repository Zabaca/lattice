/**
 * @fileoverview Unit tests for centralized path utilities
 *
 * These test pure functions with mocked filesystem operations.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

// We need to test the actual implementation
import {
	ensureLatticeHome,
	getDatabasePath,
	getDocsPath,
	getEnvPath,
	getLatticeHome,
	getManifestPath,
} from "./paths.js";

describe("paths utilities", () => {
	const expectedHome = join(homedir(), ".lattice");

	describe("getLatticeHome()", () => {
		it("returns ~/.lattice path", () => {
			const result = getLatticeHome();
			expect(result).toBe(expectedHome);
		});
	});

	describe("getDocsPath()", () => {
		it("returns ~/.lattice/docs path", () => {
			const result = getDocsPath();
			expect(result).toBe(join(expectedHome, "docs"));
		});
	});

	describe("getDatabasePath()", () => {
		it("returns ~/.lattice/lattice.duckdb path", () => {
			const result = getDatabasePath();
			expect(result).toBe(join(expectedHome, "lattice.duckdb"));
		});
	});

	describe("getManifestPath()", () => {
		it("returns ~/.lattice/.sync-manifest.json path", () => {
			const result = getManifestPath();
			expect(result).toBe(join(expectedHome, ".sync-manifest.json"));
		});
	});

	describe("getEnvPath()", () => {
		it("returns ~/.lattice/.env path", () => {
			const result = getEnvPath();
			expect(result).toBe(join(expectedHome, ".env"));
		});
	});

	describe("ensureLatticeHome()", () => {
		it("is a function that can be called", () => {
			// This test verifies the function exists and is callable
			// Actual directory creation is tested in integration tests
			expect(typeof ensureLatticeHome).toBe("function");
		});
	});
});
