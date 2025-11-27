import { Injectable, Logger } from '@nestjs/common';
import { resolve, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { DocumentParserService } from './document-parser.service.js';

export interface PathResolutionOptions {
	/** If true, throw error when path doesn't exist (default: true) */
	requireExists?: boolean;
	/** If true, throw error when path is outside docs/ (default: true) */
	requireInDocs?: boolean;
}

/**
 * Service for resolving user-provided paths to absolute form.
 *
 * Accepts paths in three formats:
 * 1. Absolute: /home/user/project/docs/topic/file.md
 * 2. Relative to CWD: docs/topic/file.md
 * 3. Relative to docs/: topic/file.md
 *
 * All paths are normalized to absolute form for consistent comparison
 * with paths returned by DocumentParserService.discoverDocuments().
 */
@Injectable()
export class PathResolverService {
	private readonly logger = new Logger(PathResolverService.name);

	constructor(private readonly parser: DocumentParserService) {}

	/**
	 * Get the configured docs path (absolute)
	 */
	getDocsPath(): string {
		return this.parser.getDocsPath();
	}

	/**
	 * Resolve a user-provided path to absolute form.
	 *
	 * Resolution order:
	 * 1. If absolute, validate and return
	 * 2. Try resolving from CWD (if result is under docs/ and exists)
	 * 3. Try resolving from docs/ directory (if exists)
	 * 4. Fall back to best-guess resolution for error message
	 *
	 * @throws Error if path cannot be resolved or doesn't meet requirements
	 */
	resolveDocPath(userPath: string, options: PathResolutionOptions = {}): string {
		const { requireExists = true, requireInDocs = true } = options;

		let resolvedPath: string;

		if (isAbsolute(userPath)) {
			// Absolute path - use directly
			resolvedPath = userPath;
		} else {
			// Try resolving from CWD first
			const fromCwd = resolve(process.cwd(), userPath);

			// Try resolving from docs/ directory
			const fromDocs = resolve(this.getDocsPath(), userPath);

			// Special case: if path starts with "docs/", strip it and resolve from docs/
			// This handles "docs/agents/file.md" when CWD is not under docs/
			const docsPrefix = 'docs/';
			const strippedFromDocs = userPath.startsWith(docsPrefix)
				? resolve(this.getDocsPath(), userPath.slice(docsPrefix.length))
				: null;

			if (this.isUnderDocs(fromCwd) && existsSync(fromCwd)) {
				// CWD resolution is under docs/ and file exists
				resolvedPath = fromCwd;
			} else if (strippedFromDocs && existsSync(strippedFromDocs)) {
				// Path started with "docs/" and exists after stripping prefix
				resolvedPath = strippedFromDocs;
			} else if (existsSync(fromDocs)) {
				// File exists when resolved from docs/
				resolvedPath = fromDocs;
			} else if (this.isUnderDocs(fromCwd)) {
				// CWD resolution is under docs/ but file doesn't exist
				// Use this path to give meaningful error message
				resolvedPath = fromCwd;
			} else if (strippedFromDocs) {
				// Path started with "docs/" - use stripped version for error
				resolvedPath = strippedFromDocs;
			} else {
				// Fall back to fromDocs for error message
				resolvedPath = fromDocs;
			}
		}

		// Validate path is under docs/ if required
		if (requireInDocs && !this.isUnderDocs(resolvedPath)) {
			throw new Error(
				`Path "${userPath}" resolves to "${resolvedPath}" which is outside the docs directory (${this.getDocsPath()})`
			);
		}

		// Validate path exists if required
		if (requireExists && !existsSync(resolvedPath)) {
			throw new Error(
				`Path "${userPath}" does not exist (resolved to: ${resolvedPath})`
			);
		}

		return resolvedPath;
	}

	/**
	 * Resolve multiple paths to absolute form.
	 *
	 * @throws Error if any path cannot be resolved
	 */
	resolveDocPaths(userPaths: string[], options: PathResolutionOptions = {}): string[] {
		return userPaths.map(p => this.resolveDocPath(p, options));
	}

	/**
	 * Check if an absolute path is under the docs/ directory
	 */
	isUnderDocs(absolutePath: string): boolean {
		const docsPath = this.getDocsPath();
		// Normalize paths for comparison (ensure trailing slash doesn't affect comparison)
		const normalizedPath = absolutePath.replace(/\/$/, '');
		const normalizedDocs = docsPath.replace(/\/$/, '');
		return normalizedPath.startsWith(normalizedDocs + '/') || normalizedPath === normalizedDocs;
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
