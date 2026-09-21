/**
 * Reranks a candidate list with TypeSafe's Jev: one request per query, one
 * Noul (yes/no) question per candidate, sorted by the returned probability.
 * Eval-only — nothing under `src/cli` imports this.
 */

import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

export interface Candidate {
	id: string;
	title: string;
	text: string;
}

export interface RerankResult {
	/** Candidate ids, best first. */
	order: string[];
	/** The model the response reports. */
	model: string;
	ms: number;
	inputTokens: number;
}

export interface JevReranker {
	rerank(query: string, candidates: Candidate[]): Promise<RerankResult>;
}

const CRITERIA = {
	true: "The candidate states the specific fact the query asks for.",
	false: "The candidate is only on a related topic.",
};

export function createJevReranker(options: {
	apiKey: string;
	model: string;
}): JevReranker {
	const client = new TypeSafeClient({ apiKey: options.apiKey });
	return {
		async rerank(query, candidates) {
			const questions: Record<string, ReturnType<typeof noul>> = {};
			for (const candidate of candidates) {
				questions[candidate.id] = noul(
					`Does candidate ${candidate.id} answer the query?`,
					CRITERIA,
				);
			}
			const started = performance.now();
			const result = await client.systemOne({
				state: {
					query,
					candidates: candidates.map(({ id, title, text }) => ({
						id,
						title,
						text,
					})),
				},
				questions,
				model: options.model,
			});
			const ms = performance.now() - started;
			const probability = (id: string): number => {
				const answer = result.answers[id];
				return answer?.type === "noul" ? answer.noul : 0;
			};
			// Stable sort: ties keep Lattice's fused order.
			const order = candidates
				.map((candidate, index) => ({ id: candidate.id, index }))
				.sort(
					(a, b) => probability(b.id) - probability(a.id) || a.index - b.index,
				)
				.map((entry) => entry.id);
			return {
				order,
				model: result.model,
				ms,
				inputTokens: result.usage.input_tokens,
			};
		},
	};
}
