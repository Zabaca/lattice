import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Injectable } from "@nestjs/common";
import { getDocsPath } from "../utils/paths.js";

export interface PathResolutionOptions {
	/** If true, throw error when path doesn't exist (default: true) */
	requireExists?: boolean;
	/** If true, throw error when path is outside docs/ (default: true) */
	requireInDocs?: boolean;
}

/**
 * Service for resolving user-provided paths to absolute form.
 *
 * All docs are now stored in ~/.lattice/docs/.
 * Accepts paths in two formats:
 * 1. Absolute: /home/user/.lattice/docs/topic/file.md
 * 2. Relative to ~/.lattice/docs/: topic/file.md
 */
@Injectable()
export class PathResolverService {
	private readonly docsPath: string;

	constructor() {
		this.docsPath = getDocsPath();
	}

	/**
	 * Get the docs path (~/.lattice/docs)
	 */
	getDocsPath(): string {
		return this.docsPath;
	}

	/**
	 * Resolve a user-provided path to absolute form.
	 *
	 * Resolution:
	 * 1. If absolute, use directly
	 * 2. Otherwise resolve relative to ~/.lattice/docs/
	 *
	 * @throws Error if path cannot be resolved or doesn't meet requirements
	 */
	resolveDocPath(
		userPath: string,
		options: PathResolutionOptions = {},
	): string {
		const { requireExists = true, requireInDocs = true } = options;

		let resolvedPath: string;

		if (isAbsolute(userPath)) {
			// Absolute path - use directly
			resolvedPath = userPath;
		} else {
			// Resolve relative to ~/.lattice/docs/
			resolvedPath = resolve(this.docsPath, userPath);
		}

		// Validate path is under docs/ if required
		if (requireInDocs && !this.isUnderDocs(resolvedPath)) {
			throw new Error(
				`Path "${userPath}" resolves to "${resolvedPath}" which is outside the docs directory (${this.docsPath})`,
			);
		}

		// Validate path exists if required
		if (requireExists && !existsSync(resolvedPath)) {
			throw new Error(
				`Path "${userPath}" does not exist (resolved to: ${resolvedPath})`,
			);
		}

		return resolvedPath;
	}

	/**
	 * Resolve multiple paths to absolute form.
	 *
	 * @throws Error if any path cannot be resolved
	 */
	resolveDocPaths(
		userPaths: string[],
		options: PathResolutionOptions = {},
	): string[] {
		return userPaths.map((p) => this.resolveDocPath(p, options));
	}

	/**
	 * Check if an absolute path is under the docs/ directory
	 */
	isUnderDocs(absolutePath: string): boolean {
		const docsPath = this.getDocsPath();
		// Normalize paths for comparison (ensure trailing slash doesn't affect comparison)
		const normalizedPath = absolutePath.replace(/\/$/, "");
		const normalizedDocs = docsPath.replace(/\/$/, "");
		return (
			normalizedPath.startsWith(`${normalizedDocs}/`) ||
			normalizedPath === normalizedDocs
		);
	}

	/**
	 * Get a relative path from the docs/ directory for display
	 */
	getRelativePath(absolutePath: string): string {
		const docsPath = this.getDocsPath();
		if (absolutePath.startsWith(docsPath)) {
			return absolutePath.slice(docsPath.length + 1); // +1 for trailing slash
		}
		return absolutePath;
	}
}
