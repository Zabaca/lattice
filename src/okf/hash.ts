/**
 * Content hashing.
 *
 * The hash is the index's notion of "the same document": it decides whether a
 * file needs re-indexing and whether a file that appeared at a new path is a
 * rename of one that disappeared. That second use is why this is a
 * cryptographic digest rather than a fast non-cryptographic one — a collision
 * would silently merge two unrelated documents.
 */

export function hashContent(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
