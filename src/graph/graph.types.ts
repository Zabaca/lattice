import { z } from "zod";

// Entity type schema - what kinds of entities we track
export const EntityTypeSchema = z.enum([
	"Topic",
	"Technology",
	"Concept",
	"Tool",
	"Process",
	"Person",
	"Organization",
	"Document",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

// Relationship type schema - simplified ontology
// Only REFERENCES is user-declarable in frontmatter
// APPEARS_IN is auto-generated when entities appear in documents
export const RelationTypeSchema = z.enum([
	"REFERENCES",
]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

// Entity definition from frontmatter
export const EntitySchema = z.object({
	name: z.string().min(1),
	type: EntityTypeSchema,
	description: z.string().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

// Relationship definition from frontmatter
export const RelationshipSchema = z.object({
	source: z.string().min(1), // Entity name or 'this' for current doc
	relation: RelationTypeSchema,
	target: z.string().min(1), // Entity name or relative path
});
export type Relationship = z.infer<typeof RelationshipSchema>;

// Graph-specific metadata for documents
export const GraphMetadataSchema = z.object({
	importance: z.enum(["high", "medium", "low"]).optional(),
	domain: z.string().optional(),
});
export type GraphMetadata = z.infer<typeof GraphMetadataSchema>;

// Graph node representation
export interface GraphNode {
	id?: number;
	labels: string[];
	properties: Record<string, unknown>;
}

// Graph edge representation
export interface GraphEdge {
	id?: number;
	type: string;
	sourceNode: string;
	targetNode: string;
	properties?: Record<string, unknown>;
}

// Graph statistics
export interface GraphStats {
	nodeCount: number;
	edgeCount: number;
	labels: string[];
	relationshipTypes: string[];
	entityCounts: Record<string, number>;
	relationshipCounts: Record<string, number>;
}

// Document info for sync
export interface DocumentInfo {
	path: string;
	title: string;
	contentHash: string;
	frontmatterHash: string;
	entities: Entity[];
	relationships: Relationship[];
	graphMetadata?: GraphMetadata;
	lastModified: Date;
}

// Sync manifest entry
export interface ManifestEntry {
	contentHash: string;
	frontmatterHash: string;
	lastSynced: string;
	entityCount: number;
	relationshipCount: number;
}

// Full sync manifest
export interface SyncManifest {
	version: string;
	lastSync: string;
	documents: Record<string, ManifestEntry>;
}

// Change detection result
export type ChangeType = "new" | "updated" | "deleted" | "unchanged";

export interface DocumentChange {
	path: string;
	changeType: ChangeType;
	reason?: string;
}

// Sync result
export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	unchanged: number;
	errors: Array<{ path: string; error: string }>;
	duration: number;
}

// FalkorDB configuration
export interface FalkorDBConfig {
	host: string;
	port: number;
	graphName: string;
}

// Cypher query result
export interface CypherResult {
	resultSet: unknown[][];
	stats?: {
		nodesCreated: number;
		nodesDeleted: number;
		relationshipsCreated: number;
		relationshipsDeleted: number;
		propertiesSet: number;
	};
}
