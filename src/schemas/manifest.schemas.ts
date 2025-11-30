import { z } from "zod";

/**
 * Individual manifest entry for a synced document
 */
export const ManifestEntrySchema = z.object({
	contentHash: z.string(),
	frontmatterHash: z.string(),
	lastSynced: z.string(),
	entityCount: z.number().int().nonnegative(),
	relationshipCount: z.number().int().nonnegative(),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/**
 * Complete sync manifest schema
 */
export const SyncManifestSchema = z.object({
	version: z.string(),
	lastSync: z.string(),
	documents: z.record(z.string(), ManifestEntrySchema),
});

export type SyncManifest = z.infer<typeof SyncManifestSchema>;
