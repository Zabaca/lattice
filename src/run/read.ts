/**
 * A fetched page as passages the judge can read.
 *
 * A search excerpt is one short highlight from a page, and for an answer
 * buried in a long reference page it is usually the wrong one. When the judge
 * says a page is worth reading in full, the page is chunked at its headings
 * exactly as an indexed document is, and the chunks are ranked against the
 * question the way the index ranks them: by the words they share, and by
 * cosine to the question when a model is on hand, fused by rank. The top few
 * become the candidate's text.
 */

import { Database } from "bun:sqlite";
import { reciprocalRankFusion } from "../search/fuse.js";
import { buildMatchExpression, extractTerms } from "../search/query.js";
import { cosine } from "../search/vector.js";
import { chunkDocument } from "../sync/chunk.js";

/** Passages handed to the judge from one page. */
export const PASSAGES_PER_PAGE = 3;
/** Chunks the keyword leg lets through to the model, which is the slow leg. */
const EMBED_CANDIDATES = 20;

export interface PassageEmbedder {
	embed(texts: string[]): Promise<Float32Array[]>;
	embedQuery(texts: string[]): Promise<Float32Array[]>;
}

export async function passagesFor(
	question: string,
	text: string,
	embedder?: PassageEmbedder,
): Promise<string[]> {
	const chunks = chunkDocument(text, 0, 0);
	if (chunks.length <= PASSAGES_PER_PAGE) {
		return chunks.map((chunk) => chunk.content);
	}

	const keyword = keywordRanking(
		question,
		chunks.map((chunk) => `${chunk.headingPath}\n${chunk.content}`),
	);
	const rankings = [keyword];
	if (embedder !== undefined) {
		const pool = keyword.slice(0, EMBED_CANDIDATES);
		if (pool.length > 0) {
			const [query] = await embedder.embedQuery([question]);
			const vectors = await embedder.embed(
				pool.map((id) => chunks[id].content),
			);
			rankings.push(
				pool
					.map((id, index) => ({
						id,
						similarity: cosine(query, vectors[index]),
					}))
					.sort((a, b) => b.similarity - a.similarity)
					.map((entry) => entry.id),
			);
		}
	}

	const fused = [...reciprocalRankFusion(rankings).entries()].sort(
		(a, b) => b[1] - a[1] || a[0] - b[0],
	);
	const chosen = fused.slice(0, PASSAGES_PER_PAGE).map(([id]) => id);
	// A page whose text shares no word with the question has nothing to
	// rank; its opening is the best guess, as it would be for a reader.
	if (chosen.length === 0) {
		return chunks.slice(0, PASSAGES_PER_PAGE).map((chunk) => chunk.content);
	}
	return chosen.sort((a, b) => a - b).map((id) => chunks[id].content);
}

/**
 * The page's chunks ranked by bm25, through an FTS5 table that lives for
 * the call: the same tokenizer and the same ranking the index's keyword leg
 * uses, so a passage found on a read page is found the way an indexed one
 * would have been. Chunks matching none of the terms are absent.
 */
function keywordRanking(question: string, texts: string[]): number[] {
	const match = buildMatchExpression(extractTerms(question), "any");
	if (match === undefined) {
		return [];
	}
	const db = new Database(":memory:");
	try {
		db.run(
			"CREATE VIRTUAL TABLE page USING fts5(content, tokenize='porter unicode61')",
		);
		const insert = db.prepare("INSERT INTO page(rowid, content) VALUES (?, ?)");
		texts.forEach((text, id) => {
			insert.run(id, text);
		});
		return db
			.prepare<{ id: number }, [string]>(
				"SELECT rowid AS id FROM page WHERE page MATCH ? ORDER BY bm25(page), rowid",
			)
			.all(match)
			.map((row) => row.id);
	} finally {
		db.close();
	}
}
