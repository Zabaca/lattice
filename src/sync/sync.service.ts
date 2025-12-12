import { Injectable, Logger } from "@nestjs/common";
import { EmbeddingService } from "../embedding/embedding.service.js";
import { GraphService } from "../graph/graph.service.js";
import {
	collectUniqueEntities,
	composeDocumentEmbeddingText,
	composeEntityEmbeddingText,
	getChangeReason,
	type ValidationError,
	validateDocuments as validateDocumentsPure,
} from "../pure/index.js";
import type { EntityProperties } from "../schemas/entity.schemas.js";
import { CascadeAnalysis, CascadeService } from "./cascade.service.js";
import { DatabaseChangeDetectorService } from "./database-change-detector.service.js";
import {
	DocumentParserService,
	ParsedDocument,
} from "./document-parser.service.js";
import { EntityExtractorService } from "./entity-extractor.service.js";
import { DocumentChange, ManifestService } from "./manifest.service.js";
import { PathResolverService } from "./path-resolver.service.js";

export interface SyncOptions {
	force?: boolean; // Force re-sync: with paths, clears only those docs; without paths, rebuilds entire graph
	dryRun?: boolean; // Show changes without applying
	verbose?: boolean; // Detailed output
	paths?: string[]; // Specific paths to sync (undefined = all)
	skipCascade?: boolean; // Skip cascade analysis (can be slow for large repos)
	embeddings?: boolean; // Generate embeddings for documents (default: true)
	skipEmbeddings?: boolean; // Explicitly skip embeddings even if enabled
	// v2 is now the default - use legacy flag to revert to v1 behavior
	useDbChangeDetection?: boolean; // Use database-based change detection (default: true)
	aiExtraction?: boolean; // Use AI to extract entities (default: true)
	legacy?: boolean; // Use v1 manifest-based detection and skip AI extraction
}

/**
 * Extended DocumentChange with embedding tracking (internal use)
 */
interface DocumentChangeWithEmbedding extends DocumentChange {
	embeddingGenerated?: boolean;
}

/**
 * Unique entity collected across all documents for deduplication
 */
export interface UniqueEntity {
	type: string;
	name: string;
	description?: string;
	documentPaths: string[]; // Track which docs define this entity
}

/**
 * All entity types that should have embeddings (excludes Document)
 */
const ENTITY_TYPES = [
	"Topic",
	"Technology",
	"Concept",
	"Tool",
	"Process",
	"Person",
	"Organization",
];

/**
 * Validate documents for relationship errors.
 * Shared function used by both sync and validate commands.
 * Returns array of validation errors. Empty array means validation passed.
 */
export function validateDocuments(docs: ParsedDocument[]): ValidationError[] {
	return validateDocumentsPure(docs);
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	unchanged: number;
	errors: Array<{ path: string; error: string }>;
	duration: number;
	changes: DocumentChange[];
	cascadeWarnings: CascadeAnalysis[];
	embeddingsGenerated: number; // Count of document embeddings generated
	entityEmbeddingsGenerated: number; // Count of entity embeddings generated
}

@Injectable()
export class SyncService {
	private readonly logger = new Logger(SyncService.name);

	constructor(
		private readonly manifest: ManifestService,
		private readonly parser: DocumentParserService,
		private readonly graph: GraphService,
		private readonly cascade: CascadeService,
		private readonly pathResolver: PathResolverService,
		private readonly dbChangeDetector: DatabaseChangeDetectorService,
		private readonly entityExtractor: EntityExtractorService,
		private readonly embeddingService?: EmbeddingService,
	) {}

	/**
	 * Main sync entry point - synchronizes documents to graph
	 * Uses entities-first flow for efficient deduplication:
	 *   Phase 1: Parse all documents into memory
	 *   Phase 2: Collect unique entities (dedupe in code)
	 *   Phase 3: Create entity nodes + embeddings (one MERGE per entity)
	 *   Phase 4: Create document nodes + embeddings
	 *   Phase 5: Create relationships
	 */
	async sync(options: SyncOptions = {}): Promise<SyncResult> {
		const startTime = Date.now();
		const result: SyncResult = {
			added: 0,
			updated: 0,
			deleted: 0,
			unchanged: 0,
			errors: [],
			duration: 0,
			changes: [],
			cascadeWarnings: [],
			embeddingsGenerated: 0,
			entityEmbeddingsGenerated: 0,
		};

		// Apply v2 defaults (unless legacy mode is explicitly requested)
		const useDbDetection = options.legacy
			? false
			: (options.useDbChangeDetection ?? true);
		const useAiExtraction = options.legacy
			? false
			: (options.aiExtraction ?? true);

		try {
			// Load manifest (needed for legacy mode and migration)
			await this.manifest.load();

			// v2: Load DB hashes for database-based change detection
			if (useDbDetection) {
				await this.dbChangeDetector.loadHashes();
				if (options.verbose) {
					this.logger.log(
						`v2 mode: Loaded ${this.dbChangeDetector.getCacheSize()} document hashes from database`,
					);
				}
			}

			// Handle force mode - clears manifest only (not graph) to force re-sync
			// MERGE operations will update existing nodes, preserving relationships
			if (options.force) {
				if (options.paths && options.paths.length > 0) {
					// Force with specific paths: clear those entries from manifest
					if (options.verbose) {
						this.logger.log(
							`Force mode: marking ${options.paths.length} document(s) for re-sync`,
						);
					}
					await this.clearManifestEntries(options.paths);
				} else {
					// Force without paths: clear entire manifest to re-sync everything
					if (options.verbose) {
						this.logger.log(
							"Force mode: clearing manifest to force full re-sync",
						);
					}
					await this.clearManifest();
				}
			}

			// Detect changes (v2 uses DB detection by default)
			const changes = await this.detectChanges(options.paths, useDbDetection);
			result.changes = changes;

			// Phase 1: Parse all documents that need syncing into memory
			const docsToSync: ParsedDocument[] = [];
			const docsByPath = new Map<string, ParsedDocument>();

			for (const change of changes) {
				if (change.changeType === "new" || change.changeType === "updated") {
					try {
						const doc = await this.parser.parseDocument(change.path);
						docsToSync.push(doc);
						docsByPath.set(change.path, doc);
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						result.errors.push({ path: change.path, error: errorMessage });
						this.logger.warn(`Failed to parse ${change.path}: ${errorMessage}`);
					}
				}
			}

			// v2: AI entity extraction (replaces frontmatter parsing)
			if (useAiExtraction && docsToSync.length > 0) {
				if (options.verbose) {
					this.logger.log(
						`v2 AI extraction: Processing ${docsToSync.length} documents...`,
					);
				}

				for (const doc of docsToSync) {
					try {
						const extraction = await this.entityExtractor.extractFromDocument(
							doc.path,
						);
						if (extraction.success) {
							// Populate doc with AI-extracted entities and relationships
							doc.entities = extraction.entities;
							doc.relationships = extraction.relationships;
							// AI summary takes precedence over frontmatter summary
							if (extraction.summary) {
								doc.summary = extraction.summary;
							}
							if (options.verbose) {
								this.logger.log(
									`  Extracted ${extraction.entities.length} entities from ${doc.path}`,
								);
							}
						} else {
							this.logger.warn(
								`AI extraction failed for ${doc.path}: ${extraction.error}`,
							);
							// Continue with empty entities - don't fail the sync
						}
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						this.logger.warn(
							`AI extraction error for ${doc.path}: ${errorMsg}`,
						);
						// Continue with empty entities
					}
				}
			}

			// Phase 1.5: Validate relationships before proceeding
			// (Skip validation in AI mode - AI output is already sanitized)
			if (!useAiExtraction) {
				const validationErrors = validateDocuments(docsToSync);
				if (validationErrors.length > 0) {
					// Add validation errors to result and fail early
					for (const err of validationErrors) {
						result.errors.push(err);
						this.logger.error(`Validation error in ${err.path}: ${err.error}`);
					}
					this.logger.error(
						`Sync aborted: ${validationErrors.length} validation error(s) found. Fix the errors and try again.`,
					);
					result.duration = Date.now() - startTime;
					return result;
				}
			}

			// Phase 2: Collect unique entities from all parsed documents
			const uniqueEntities = collectUniqueEntities(docsToSync);

			if (options.verbose) {
				this.logger.log(
					`Collected ${uniqueEntities.size} unique entities from ${docsToSync.length} documents`,
				);
			}

			// Phase 3: Create vector indices if embeddings enabled
			if (
				options.embeddings &&
				!options.skipEmbeddings &&
				this.embeddingService
			) {
				// Document index
				try {
					const dimensions = this.embeddingService.getDimensions();
					await this.graph.createVectorIndex(
						"Document",
						"embedding",
						dimensions,
					);
				} catch (error) {
					this.logger.debug(
						`Vector index setup for Document: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				// Entity indices
				await this.createEntityVectorIndices();
			}

			// Phase 4: Sync entities with embeddings (one MERGE per unique entity)
			if (!options.dryRun) {
				result.entityEmbeddingsGenerated = await this.syncEntities(
					uniqueEntities,
					options,
				);

				// Checkpoint after entity sync to ensure persistence
				await this.graph.checkpoint();

				if (options.verbose) {
					this.logger.log(
						`Synced ${uniqueEntities.size} entities, generated ${result.entityEmbeddingsGenerated} embeddings`,
					);
				}
			}

			// Phase 5 & 6: Process each change (document nodes + relationships)
			// Errors now halt sync - no silent failures
			const CHECKPOINT_BATCH_SIZE = 10; // Checkpoint every N documents
			let processedCount = 0;

			for (const change of changes) {
				const doc = docsByPath.get(change.path);
				const cascadeWarnings = await this.processChange(change, options, doc);
				result.cascadeWarnings.push(...cascadeWarnings);

				// Update result counts
				switch (change.changeType) {
					case "new":
						result.added++;
						break;
					case "updated":
						result.updated++;
						break;
					case "deleted":
						result.deleted++;
						break;
					case "unchanged":
						result.unchanged++;
						break;
				}

				// Count embeddings generated
				if ((change as DocumentChangeWithEmbedding).embeddingGenerated) {
					result.embeddingsGenerated++;
				}

				// Save manifest after each successful change (incremental progress)
				if (!options.dryRun && change.changeType !== "unchanged") {
					await this.manifest.save();
				}

				// Checkpoint periodically to ensure database persistence
				processedCount++;
				if (!options.dryRun && processedCount % CHECKPOINT_BATCH_SIZE === 0) {
					await this.graph.checkpoint();
				}
			}

			// Final checkpoint after all documents processed
			if (!options.dryRun && processedCount > 0) {
				await this.graph.checkpoint();
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Sync failed: ${errorMessage}`);
			result.errors.push({ path: "sync", error: errorMessage });
		}

		result.duration = Date.now() - startTime;
		return result;
	}

	/**
	 * Detect changes between manifest (v1) or database (v2) and current documents
	 */
	async detectChanges(
		paths?: string[],
		useDbDetection = false,
	): Promise<DocumentChange[]> {
		const changes: DocumentChange[] = [];

		// Discover all documents
		let allDocPaths = await this.parser.discoverDocuments();

		// Filter by specific paths if provided
		if (paths && paths.length > 0) {
			// Normalize user-provided paths to absolute form for comparison
			const normalizedPaths = this.pathResolver.resolveDocPaths(paths, {
				requireExists: true,
				requireInDocs: true,
			});
			const pathSet = new Set(normalizedPaths);
			allDocPaths = allDocPaths.filter((p) => pathSet.has(p));
		}

		// Get tracked paths from manifest (v1) or database (v2)
		const trackedPaths = new Set(
			useDbDetection
				? this.dbChangeDetector.getTrackedPaths()
				: this.manifest.getTrackedPaths(),
		);

		// Check each document on disk
		for (const docPath of allDocPaths) {
			try {
				const doc = await this.parser.parseDocument(docPath);

				// v2: Use database change detection
				// v1: Use manifest change detection
				const changeType = useDbDetection
					? this.dbChangeDetector.detectChange(docPath, doc.contentHash)
					: this.manifest.detectChange(
							docPath,
							doc.contentHash,
							doc.frontmatterHash,
						);

				changes.push({
					path: docPath,
					changeType,
					reason: getChangeReason(changeType),
				});

				// Remove from tracked set (remaining will be deletions)
				trackedPaths.delete(docPath);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				this.logger.warn(`Failed to parse ${docPath}: ${errorMessage}`);
				changes.push({
					path: docPath,
					changeType: "new", // Treat parse errors as new for retry
					reason: `Parse error: ${errorMessage}`,
				});
				trackedPaths.delete(docPath);
			}
		}

		// Any remaining tracked paths are deletions (unless filtering by paths)
		if (!paths || paths.length === 0) {
			for (const deletedPath of trackedPaths) {
				changes.push({
					path: deletedPath,
					changeType: "deleted",
					reason: "File no longer exists",
				});
			}
		}

		return changes;
	}

	/**
	 * Sync a single document to the graph
	 * Returns true if an embedding was generated
	 *
	 * @param doc - Parsed document to sync
	 * @param options - Sync options
	 * @param skipEntityCreation - Skip entity node creation (entities already synced)
	 */
	async syncDocument(
		doc: ParsedDocument,
		options: SyncOptions = {},
		skipEntityCreation = false,
	): Promise<boolean> {
		// First, remove any existing relationships for this document
		// This ensures clean update on changes
		await this.graph.deleteDocumentRelationships(doc.path);

		// Create/update Document node
		const documentProps: EntityProperties = {
			name: doc.path,
			title: doc.title ?? "",
			contentHash: doc.contentHash,
			tags: doc.tags ?? [],
		};

		// Add optional fields
		if (doc.summary) documentProps.summary = doc.summary;
		if (doc.created) documentProps.created = doc.created;
		if (doc.updated) documentProps.updated = doc.updated;
		if (doc.status) documentProps.status = doc.status;

		// Add graph metadata
		if (doc.graphMetadata) {
			if (doc.graphMetadata.importance) {
				documentProps.importance = doc.graphMetadata.importance;
			}
			if (doc.graphMetadata.domain) {
				documentProps.domain = doc.graphMetadata.domain;
			}
		}

		await this.graph.upsertNode("Document", documentProps);

		// Generate and store embedding if requested
		let embeddingGenerated = false;
		if (
			options.embeddings &&
			!options.skipEmbeddings &&
			this.embeddingService
		) {
			try {
				// Compose rich embedding text from multiple fields
				const textForEmbedding = composeDocumentEmbeddingText(doc);
				if (textForEmbedding.trim()) {
					const embedding =
						await this.embeddingService.generateEmbedding(textForEmbedding);
					await this.graph.updateNodeEmbedding("Document", doc.path, embedding);
					embeddingGenerated = true;
					this.logger.debug(`Generated embedding for ${doc.path}`);
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to generate embedding for ${doc.path}: ${errorMessage}`,
				);
			}
		}

		// Build entity type lookup for relationship resolution
		const entityTypeMap = new Map<string, string>();
		entityTypeMap.set(doc.path, "Document"); // Document itself can be a relationship source

		this.logger.debug(
			`syncDocument: ${doc.path} has ${doc.entities.length} entities, skipEntityCreation=${skipEntityCreation}`,
		);

		// Create entity nodes (skip if entities were pre-synced in entities-first flow)
		for (const entity of doc.entities) {
			// Track entity types for relationship resolution (always needed)
			entityTypeMap.set(entity.name, entity.type);

			if (!skipEntityCreation) {
				const entityProps: EntityProperties = {
					name: entity.name,
				};
				if (entity.description) {
					entityProps.description = entity.description;
				}
				await this.graph.upsertNode(entity.type, entityProps);
			}

			// Create APPEARS_IN relationship from entity to document (always create)
			this.logger.debug(
				`Creating APPEARS_IN: ${entity.type}:${entity.name} -> Document:${doc.path}`,
			);
			await this.graph.upsertRelationship(
				entity.type,
				entity.name,
				"APPEARS_IN",
				"Document",
				doc.path,
				{ documentPath: doc.path },
			);
		}

		// Create user-defined relationships
		for (const rel of doc.relationships) {
			// Handle special case: source is "this" (refers to the document itself)
			if (rel.source === "this") {
				const targetType = entityTypeMap.get(rel.target);
				if (!targetType) {
					this.logger.warn(
						`Unknown target entity "${rel.target}" in relationship, document: ${doc.path}`,
					);
					continue;
				}
				// Create Document → Entity relationship
				await this.graph.upsertRelationship(
					"Document",
					doc.path,
					rel.relation,
					targetType,
					rel.target,
					{ documentPath: doc.path },
				);
				continue;
			}

			// Handle special case: target is a document path (ends with .md)
			if (rel.target.endsWith(".md")) {
				const sourceType = entityTypeMap.get(rel.source);
				if (!sourceType) {
					this.logger.warn(
						`Unknown source entity "${rel.source}" in relationship, document: ${doc.path}`,
					);
					continue;
				}
				// Create Entity → Document relationship
				await this.graph.upsertRelationship(
					sourceType,
					rel.source,
					rel.relation,
					"Document",
					rel.target,
					{ documentPath: doc.path },
				);
				continue;
			}

			// Standard entity-to-entity relationship
			const sourceType = entityTypeMap.get(rel.source);
			const targetType = entityTypeMap.get(rel.target);

			if (!sourceType) {
				this.logger.warn(
					`Unknown source entity "${rel.source}" in relationship, document: ${doc.path}`,
				);
				continue;
			}

			if (!targetType) {
				this.logger.warn(
					`Unknown target entity "${rel.target}" in relationship, document: ${doc.path}`,
				);
				continue;
			}

			await this.graph.upsertRelationship(
				sourceType,
				rel.source,
				rel.relation,
				targetType,
				rel.target,
				{ documentPath: doc.path },
			);
		}

		return embeddingGenerated;
	}

	/**
	 * Remove a document from the graph
	 */
	async removeDocument(path: string): Promise<void> {
		// Remove relationships first (they reference the document)
		await this.graph.deleteDocumentRelationships(path);

		// Then remove the Document node
		await this.graph.deleteNode("Document", path);

		// Note: We don't remove entity nodes as they may be referenced by other documents
	}

	/**
	 * Process a single change based on its type.
	 * Returns cascade warnings detected during processing.
	 *
	 * @param change - The document change to process
	 * @param options - Sync options
	 * @param preloadedDoc - Optional pre-parsed document (from entities-first flow)
	 */
	private async processChange(
		change: DocumentChange,
		options: SyncOptions,
		preloadedDoc?: ParsedDocument,
	): Promise<CascadeAnalysis[]> {
		const cascadeWarnings: CascadeAnalysis[] = [];
		if (options.verbose) {
			this.logger.log(`Processing ${change.changeType}: ${change.path}`);
		}

		// In dry-run mode, just log what would happen
		if (options.dryRun) {
			this.logger.log(`[DRY-RUN] Would ${change.changeType}: ${change.path}`);
			return cascadeWarnings;
		}

		switch (change.changeType) {
			case "new":
			case "updated": {
				// Use preloaded doc if available (entities-first flow), otherwise parse
				const doc =
					preloadedDoc || (await this.parser.parseDocument(change.path));

				// For UPDATED documents, analyze cascade impact
				if (change.changeType === "updated" && !options.skipCascade) {
					try {
						const oldDoc = await this.getOldDocumentFromManifest(change.path);
						if (oldDoc) {
							const cascadeAnalyses = await this.cascade.analyzeDocumentChange(
								oldDoc,
								doc,
							);
							if (cascadeAnalyses.length > 0) {
								cascadeWarnings.push(...cascadeAnalyses);
								cascadeAnalyses.forEach((cascade) => {
									this.logger.debug(
										`Cascade detected: ${cascade.trigger} in ${cascade.sourceDocument}`,
									);
								});
							}
						}
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						this.logger.warn(
							`Failed to analyze cascade impacts for ${change.path}: ${errorMessage}`,
						);
					}
				}

				// Sync document with skipEntityCreation since entities were pre-synced
				const embeddingGenerated = await this.syncDocument(
					doc,
					options,
					preloadedDoc !== undefined,
				);
				// Track if embedding was generated for result counting
				(change as DocumentChangeWithEmbedding).embeddingGenerated =
					embeddingGenerated;

				// Re-read file to get current hash before updating manifest
				// This prevents race conditions where the file is modified during sync
				const currentDoc = await this.parser.parseDocument(change.path);

				// Update manifest with current file state (v1 compatibility)
				this.manifest.updateEntry(
					currentDoc.path,
					currentDoc.contentHash,
					currentDoc.frontmatterHash,
					currentDoc.entities.length,
					currentDoc.relationships.length,
				);

				// v2: Also update database hashes (default behavior unless legacy mode)
				const shouldUpdateDbHashes = options.legacy
					? false
					: (options.useDbChangeDetection ?? true);
				if (shouldUpdateDbHashes) {
					// Compute embedding source hash if embedding was generated
					const embeddingSourceHash = embeddingGenerated
						? currentDoc.contentHash // Use content hash as embedding source for now
						: undefined;
					await this.graph.updateDocumentHashes(
						currentDoc.path,
						currentDoc.contentHash,
						embeddingSourceHash,
					);
				}
				break;
			}

			case "deleted": {
				// Remove from graph and manifest
				await this.removeDocument(change.path);
				this.manifest.removeEntry(change.path);
				break;
			}

			case "unchanged":
				// Nothing to do
				break;
		}

		return cascadeWarnings;
	}

	/**
	 * Clear the manifest (for force mode) by reloading as empty
	 */
	private async clearManifest(): Promise<void> {
		// The manifest service will create an empty manifest when we save
		// We just need to clear the in-memory documents
		const manifest = await this.manifest.load();
		// Clear all documents
		for (const path of Object.keys(manifest.documents)) {
			this.manifest.removeEntry(path);
		}
		this.logger.log("Manifest cleared");
	}

	/**
	 * Clear specific paths from the manifest only (for force mode with paths)
	 * Does NOT delete from graph - MERGE will update existing nodes
	 */
	private async clearManifestEntries(paths: string[]): Promise<void> {
		// Normalize paths before clearing
		const normalizedPaths = this.pathResolver.resolveDocPaths(paths, {
			requireExists: true,
			requireInDocs: true,
		});

		for (const docPath of normalizedPaths) {
			this.manifest.removeEntry(docPath);
			this.logger.debug(`Cleared manifest entry: ${docPath}`);
		}
		this.logger.log(`Marked ${normalizedPaths.length} document(s) for re-sync`);
	}

	/**
	 * Retrieve the old document from manifest cache for cascade analysis.
	 * This constructs a ParsedDocument from the cached manifest entry.
	 */
	private async getOldDocumentFromManifest(
		path: string,
	): Promise<ParsedDocument | null> {
		try {
			// Get the manifest (should already be loaded)
			const manifest = await this.manifest.load();
			const entry = manifest.documents[path];

			if (!entry) {
				return null;
			}

			// Since we don't have the full old document cached, try to get it from disk
			// But it may have been deleted, so return null in that case
			try {
				return await this.parser.parseDocument(path);
			} catch {
				// If we can't parse it, return null (will be treated as new document for cascade)
				return null;
			}
		} catch (error) {
			this.logger.warn(
				`Failed to retrieve old document for ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	/**
	 * Create entity nodes and generate embeddings.
	 * Called once per unique entity (deduplicated in code).
	 */
	private async syncEntities(
		entities: Map<string, UniqueEntity>,
		options: SyncOptions,
	): Promise<number> {
		let embeddingsGenerated = 0;

		for (const [_key, entity] of entities) {
			// Create node (single MERGE per entity)
			const entityProps: EntityProperties = {
				name: entity.name,
			};
			if (entity.description) {
				entityProps.description = entity.description;
			}

			await this.graph.upsertNode(entity.type, entityProps);

			// Generate embedding if enabled
			if (
				options.embeddings &&
				!options.skipEmbeddings &&
				this.embeddingService
			) {
				try {
					const text = composeEntityEmbeddingText(entity);
					const embedding = await this.embeddingService.generateEmbedding(text);
					await this.graph.updateNodeEmbedding(
						entity.type,
						entity.name,
						embedding,
					);
					embeddingsGenerated++;
					this.logger.debug(
						`Generated embedding for ${entity.type}:${entity.name}`,
					);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					throw new Error(
						`Failed to generate embedding for ${entity.type}:${entity.name}: ${errorMessage}`,
					);
				}
			}
		}

		return embeddingsGenerated;
	}

	/**
	 * Create vector indices for all entity types.
	 * Called during sync if embeddings are enabled.
	 */
	private async createEntityVectorIndices(): Promise<void> {
		if (!this.embeddingService) return;

		const dimensions = this.embeddingService.getDimensions();

		for (const entityType of ENTITY_TYPES) {
			try {
				await this.graph.createVectorIndex(entityType, "embedding", dimensions);
			} catch (error) {
				// Index creation failures are non-fatal (might already exist)
				this.logger.debug(
					`Vector index setup for ${entityType}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}
