/**
 * Turning what a person typed into an FTS5 MATCH expression.
 *
 * A question typed at a prompt carries punctuation, quotes, hyphens and the
 * words "and", "or" and "not" — all of which FTS5 reads as syntax. Nothing the
 * user types is ever passed through as syntax: the text is broken into tokens
 * here and every token is re-emitted double-quoted, so the only operators in
 * the final expression are the ones this module put there.
 */

/** Words FTS5 reads as operators, which a natural question uses as words. */
const OPERATORS = new Set(["and", "or", "not", "near"]);

/**
 * Characters FTS5's unicode61 tokenizer keeps. Everything else — quotes,
 * hyphens, dots, colons, parentheses — is a separator, so `user_id`,
 * `voyage-3-lite` and `ERR_MODULE_NOT_FOUND` each break into several tokens.
 */
const TOKEN = /[\p{L}\p{N}_]+/gu;

/**
 * Build the MATCH expression for `text`, or undefined when it holds nothing
 * searchable. Undefined is a real answer — an empty result, not an error.
 *
 * A word the user wrote as one word stays one word: if it tokenizes into
 * several pieces it becomes a quoted phrase, so `user_id` matches the two
 * tokens in that order rather than any document mentioning "user" somewhere
 * and "id" somewhere else. Separate words are joined with OR, so a long
 * question produces candidates instead of demanding every word be present;
 * BM25 is what sorts the ones matching more of them to the top.
 */
export function buildMatchExpression(text: string): string | undefined {
	const terms: string[] = [];

	for (const word of text.split(/\s+/)) {
		const tokens = word.match(TOKEN) ?? [];
		const kept = tokens.filter(
			(token) => tokens.length > 1 || !OPERATORS.has(token.toLowerCase()),
		);
		if (kept.length === 0) {
			continue;
		}
		terms.push(`"${kept.join(" ")}"`);
	}

	return terms.length === 0 ? undefined : terms.join(" OR ");
}

/**
 * The distinct tokens of `text`, lowercased — what a title is checked against
 * when deciding whether a match is a title match.
 */
export function queryTokens(text: string): string[] {
	const tokens = (text.toLowerCase().match(TOKEN) ?? []).filter(
		(token) => !OPERATORS.has(token),
	);
	return [...new Set(tokens)];
}
