/**
 * Working out what a sync has to do.
 *
 * Content hashes, not timestamps: a file whose hash matches what is indexed
 * needs no work however its mtime moved, and a file that appears at a new path
 * carrying the hash of one that disappeared is a rename, which keeps the
 * concept's identity so inbound links survive.
 */

import type { BundleFile } from "./bundle.js";

export interface IndexedConcept {
	id: number;
	path: string;
	contentHash: string;
}

export interface FileWithHash extends BundleFile {
	contentHash: string;
}

export interface Rename {
	conceptId: number;
	fromPath: string;
	file: FileWithHash;
}

export interface SyncPlan {
	added: FileWithHash[];
	changed: Array<{ conceptId: number; file: FileWithHash }>;
	renamed: Rename[];
	/** Concept ids whose file is gone. */
	deleted: IndexedConcept[];
	unchanged: number;
}

/** Diff the bundle against what is indexed. */
export function planSync(
	files: FileWithHash[],
	indexed: IndexedConcept[],
): SyncPlan {
	const byPath = new Map(indexed.map((concept) => [concept.path, concept]));
	const onDisk = new Set(files.map((file) => file.path));

	const plan: SyncPlan = {
		added: [],
		changed: [],
		renamed: [],
		deleted: [],
		unchanged: 0,
	};

	/** Indexed concepts whose file is gone: rename candidates by hash. */
	const orphansByHash = new Map<string, IndexedConcept[]>();
	for (const concept of indexed) {
		if (onDisk.has(concept.path)) {
			continue;
		}
		const bucket = orphansByHash.get(concept.contentHash);
		if (bucket === undefined) {
			orphansByHash.set(concept.contentHash, [concept]);
		} else {
			bucket.push(concept);
		}
	}

	const takenOrphans = new Set<number>();

	for (const file of files) {
		const existing = byPath.get(file.path);

		if (existing !== undefined) {
			if (existing.contentHash === file.contentHash) {
				plan.unchanged++;
			} else {
				plan.changed.push({ conceptId: existing.id, file });
			}
			continue;
		}

		const orphan = orphansByHash
			.get(file.contentHash)
			?.find((candidate) => !takenOrphans.has(candidate.id));

		if (orphan !== undefined) {
			takenOrphans.add(orphan.id);
			plan.renamed.push({
				conceptId: orphan.id,
				fromPath: orphan.path,
				file,
			});
			continue;
		}

		plan.added.push(file);
	}

	for (const concept of indexed) {
		if (!onDisk.has(concept.path) && !takenOrphans.has(concept.id)) {
			plan.deleted.push(concept);
		}
	}

	return plan;
}
