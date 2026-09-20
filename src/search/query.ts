/**
 * Turning what someone typed into something FTS5 will accept.
 *
 * A natural-language question is full of characters FTS5 reads as syntax:
 * quotes, parentheses, hyphens, asterisks, and the bare words `AND`, `OR`,
 * `NOT` and `NEAR`. None of that is an instruction here — it is text. So the
 * query is reduced to its terms and each term is re-emitted as a quoted
 * string literal, which FTS5 can only read as a word.
 */

/**
 * Whether every term must appear, or any one of them is enough.
 *
 * `all` is tried first because it is the precise answer; `any` is the retry
 * that turns a question with no exact answer into candidates.
 */
export type MatchMode = "all" | "any";

/**
 * The words in a query.
 *
 * The split mirrors the index's `unicode61` tokenizer: a run of letters or
 * digits is a term, and everything else — including `_` and `-` — separates
 * them. So `user_id` searches as `user` followed by `id`, the same two tokens
 * the indexer stored.
 */
export function extractTerms(raw: string): string[] {
	const matches = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	return [...new Set(matches)];
}

/**
 * The FTS5 MATCH expression for a set of terms.
 *
 * Each term is a double-quoted string literal with its own quotes doubled, so
 * no term can close the literal and be read as syntax.
 */
export function buildMatchExpression(
	terms: string[],
	mode: MatchMode,
): string | undefined {
	if (terms.length === 0) {
		return undefined;
	}
	const literals = terms.map((term) => `"${term.replaceAll('"', '""')}"`);
	return literals.join(mode === "all" ? " " : " OR ");
}

/** How many of `terms` appear in `text`, as a fraction of the terms asked for. */
export function termCoverage(terms: string[], text: string | null): number {
	if (terms.length === 0 || text === null || text === "") {
		return 0;
	}
	const haystack = text.toLowerCase();
	const found = terms.filter((term) => haystack.includes(term)).length;
	return found / terms.length;
}
