/**
 * Where a second opinion on the shortlist comes from.
 *
 * The fused ranking is built from cheap signals — term tiers and a cosine —
 * and a reranker is the one stage allowed to read the query and each
 * candidate together and say how well the passage actually answers. It is
 * off unless the environment names one, so with nothing set there is no
 * network call and search behaves exactly as it did.
 *
 * `jev` is the real one, TypeSafe's Jev behind `TYPESAFE_API_KEY`. `stub`
 * returns whatever probabilities `LATTICE_RERANK_STUB` declares, which is what
 * lets the test suite show a reordering and a fallback without a key.
 */

import { jevRerankerFromEnv } from "./jev.js";
import { STUB_RERANKER, stubRerankerFromEnv } from "./stub.js";

export const RERANK_PROVIDER_VAR = "LATTICE_RERANK_PROVIDER";

/**
 * A failure that no retry will fix — a rejected key, say. A search does not
 * degrade past one of these: it stops, so the mistake is seen once rather
 * than paid for on every search after it.
 */
export class RerankConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RerankConfigurationError";
	}
}

export interface RerankCandidate {
	/** What the reranker is asked about; the answers come back keyed by it. */
	id: string;
	text: string;
}

export interface RerankResponse {
	/** Candidate id to the probability it answers the query, in [0, 1]. */
	probabilities: Map<string, number>;
	/** The model that actually answered, which may be more specific than the one asked for. */
	model: string;
	inputTokens: number;
}

export interface Reranker {
	readonly name: string;
	/** The model asked for, before the service names the exact one it ran. */
	readonly model: string;
	rerank(query: string, candidates: RerankCandidate[]): Promise<RerankResponse>;
}

/**
 * The reranker the environment names, or nothing when it names none.
 *
 * A name that is not known, a `jev` with no key and a malformed stub all
 * throw rather than degrade: a configuration mistake that quietly fell back
 * would make every search weaker and never say so.
 */
export function selectReranker(
	env: Record<string, string | undefined>,
): Reranker | undefined {
	const name = env[RERANK_PROVIDER_VAR]?.trim();
	if (!name) {
		return undefined;
	}
	if (name === "jev") {
		return jevRerankerFromEnv(env);
	}
	if (name === STUB_RERANKER) {
		return stubRerankerFromEnv(env);
	}
	throw new Error(
		`Unknown reranker in ${RERANK_PROVIDER_VAR}: ${name}. Known rerankers: jev, ${STUB_RERANKER}.`,
	);
}
