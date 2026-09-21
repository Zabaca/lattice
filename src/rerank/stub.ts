/**
 * A reranker that can be told what the answers are.
 *
 * `LATTICE_RERANK_STUB` is a JSON object of phrase to probability; a
 * candidate scores the highest probability of any phrase its text contains,
 * and 0 when it contains none. `LATTICE_RERANK_FAIL` names a substring that
 * makes the request throw when the query contains it, which is the only way
 * to exercise the fallback without a network to lose.
 *
 * It is named `stub` in the environment so it can never be selected by
 * accident.
 */

import type { RerankCandidate, Reranker, RerankResponse } from "./provider.js";

export const STUB_RERANKER = "stub";
export const STUB_SCORES_VAR = "LATTICE_RERANK_STUB";
export const STUB_FAIL_VAR = "LATTICE_RERANK_FAIL";

export class StubReranker implements Reranker {
	readonly name = STUB_RERANKER;
	readonly model = "stub";
	private readonly scores: [string, number][];
	private readonly failOn?: string;

	constructor(scores: Record<string, number>, failOn?: string) {
		this.scores = Object.entries(scores).map(([phrase, probability]) => [
			phrase.toLowerCase(),
			probability,
		]);
		this.failOn = failOn;
	}

	async rerank(
		query: string,
		candidates: RerankCandidate[],
	): Promise<RerankResponse> {
		if (this.failOn !== undefined && query.includes(this.failOn)) {
			throw new Error(`injected failure on "${this.failOn}"`);
		}
		const probabilities = new Map<string, number>();
		for (const candidate of candidates) {
			const haystack = candidate.text.toLowerCase();
			let best = 0;
			for (const [phrase, probability] of this.scores) {
				if (haystack.includes(phrase)) {
					best = Math.max(best, probability);
				}
			}
			probabilities.set(candidate.id, best);
		}
		return { probabilities, model: this.model, inputTokens: 0 };
	}
}

/** A malformed table is an error: a stub that scored everything 0 would look like a model that disagreed with the fusion. */
export function stubRerankerFromEnv(
	env: Record<string, string | undefined>,
): StubReranker {
	const raw = env[STUB_SCORES_VAR]?.trim();
	if (!raw) {
		throw new Error(
			`The ${STUB_RERANKER} reranker needs ${STUB_SCORES_VAR}: a JSON object of phrase to probability.`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${STUB_SCORES_VAR} is not valid JSON.`);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!Object.values(parsed).every(
			(value) => typeof value === "number" && value >= 0 && value <= 1,
		)
	) {
		throw new Error(
			`${STUB_SCORES_VAR} must be a JSON object of phrase to a probability between 0 and 1.`,
		);
	}

	return new StubReranker(
		parsed as Record<string, number>,
		env[STUB_FAIL_VAR]?.trim() || undefined,
	);
}
