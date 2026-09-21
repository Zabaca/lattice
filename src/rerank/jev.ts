/**
 * TypeSafe's Jev as a reranker: one request per search, one Noul (yes/no)
 * question per candidate, and the probability of "yes" is the score.
 *
 * The whole shortlist travels in one state object so the model reads every
 * candidate against the same query, which is both cheaper than a request per
 * candidate and what lets it judge them relative to each other.
 */

import {
	AuthenticationError,
	noul,
	PermissionDeniedError,
	TypeSafeClient,
} from "@typesafe-ai/sdk";
import {
	type RerankCandidate,
	RerankConfigurationError,
	type Reranker,
	type RerankResponse,
} from "./provider.js";

export const API_KEY_VAR = "TYPESAFE_API_KEY";
export const RERANK_MODEL_VAR = "LATTICE_RERANK_MODEL";
export const DEFAULT_RERANK_MODEL = "jev-latest";

/** What "answers the query" means, told to the model in its own terms. */
const CRITERIA = {
	true: "The candidate states the specific fact the query asks for.",
	false: "The candidate is only on a related topic.",
};

export class JevReranker implements Reranker {
	readonly name = "jev";
	readonly model: string;
	private readonly client: TypeSafeClient;

	constructor(options: { apiKey: string; model: string; baseURL?: string }) {
		this.model = options.model;
		this.client = new TypeSafeClient({
			apiKey: options.apiKey,
			baseURL: options.baseURL,
			// A failed request is reported through the search result, not
			// printed over it.
			logLevel: "off",
		});
	}

	async rerank(
		query: string,
		candidates: RerankCandidate[],
	): Promise<RerankResponse> {
		const questions: Record<string, ReturnType<typeof noul>> = {};
		for (const candidate of candidates) {
			questions[candidate.id] = noul(
				`Does candidate ${candidate.id} answer the query?`,
				CRITERIA,
			);
		}
		let result: Awaited<ReturnType<TypeSafeClient["systemOne"]>>;
		try {
			result = await this.client.systemOne({
				state: {
					query,
					candidates: candidates.map(({ id, text }) => ({ id, text })),
				},
				questions,
				model: this.model,
			});
		} catch (error) {
			// A key the service rejects is the configuration's fault, not the
			// network's, and will reject the same way on every search.
			if (
				error instanceof AuthenticationError ||
				error instanceof PermissionDeniedError
			) {
				throw new RerankConfigurationError(
					`TypeSafe rejected ${API_KEY_VAR} (${error.status}): ${error.message}`,
				);
			}
			throw error;
		}

		const probabilities = new Map<string, number>();
		for (const candidate of candidates) {
			const answer = result.answers[candidate.id];
			probabilities.set(
				candidate.id,
				answer?.type === "noul" ? answer.noul : 0,
			);
		}
		return {
			probabilities,
			model: result.model,
			inputTokens: result.usage.input_tokens,
		};
	}
}

/** The Jev reranker as the environment configures it; no key is an error. */
export function jevRerankerFromEnv(
	env: Record<string, string | undefined>,
): JevReranker {
	const apiKey = env[API_KEY_VAR]?.trim();
	if (!apiKey) {
		throw new Error(
			`The jev reranker needs ${API_KEY_VAR} set to a TypeSafe API key.`,
		);
	}
	return new JevReranker({
		apiKey,
		model: env[RERANK_MODEL_VAR]?.trim() || DEFAULT_RERANK_MODEL,
		baseURL: env.TYPESAFE_BASE_URL?.trim() || undefined,
	});
}
