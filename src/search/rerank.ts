/**
 * The reranking stage: between fusion and expansion.
 *
 * Fusion decides which passages are worth reading; this decides, of those,
 * which actually answer. It sees more candidates than the page will show,
 * because a reranker's whole value is promoting something the cheap signals
 * ranked just off the page. Expansion runs afterwards so neighbours hang off
 * the answers as reranked, still below them.
 *
 * A request that fails costs the reordering, not the search: the fused order
 * stands, and the result says why. The one exception is a failure that is
 * really a configuration mistake, which is thrown so the command can refuse.
 */

import { RerankConfigurationError, type Reranker } from "../rerank/provider.js";
import type { SearchHit } from "./rows.js";

export interface RerankInput {
	hit: SearchHit;
	conceptId: number;
	/** What the reranker reads for this candidate. */
	text: string;
}

export interface RerankInfo {
	provider: string;
	model: string;
	/** How many candidates were sent. */
	candidates: number;
	inputTokens: number;
}

export interface RerankOutcome {
	/** The page: reranked when it could be, in fused order when it could not. */
	ordered: { hit: SearchHit; conceptId: number }[];
	rerank: RerankInfo | null;
	/** Why a configured reranker did not reorder, when it did not. */
	rerankReason?: string;
}

export async function rerankStage(
	reranker: Reranker | undefined,
	query: string,
	candidates: RerankInput[],
	limit: number,
): Promise<RerankOutcome> {
	const fusedOrder = candidates.slice(0, limit);
	if (reranker === undefined || candidates.length === 0) {
		return { ordered: fusedOrder, rerank: null };
	}

	let response: Awaited<ReturnType<Reranker["rerank"]>>;
	try {
		response = await reranker.rerank(
			query,
			candidates.map((candidate) => ({
				id: candidate.hit.path,
				text: candidate.text,
			})),
		);
	} catch (error) {
		// A misconfiguration is not a bad day for the network; it is refused
		// upward rather than degraded past.
		if (error instanceof RerankConfigurationError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			ordered: fusedOrder,
			rerank: null,
			rerankReason: `${reranker.name} reranking failed: ${message}`,
		};
	}

	// The probability becomes the score, so position and score still agree;
	// the fused score stays beside it, and settles ties.
	const scored = candidates.map(({ hit, conceptId }) => ({
		conceptId,
		hit: {
			...hit,
			score: response.probabilities.get(hit.path) ?? 0,
			fusedScore: hit.score,
		},
	}));
	scored.sort(
		(a, b) =>
			b.hit.score - a.hit.score ||
			(b.hit.fusedScore ?? 0) - (a.hit.fusedScore ?? 0) ||
			(a.hit.path < b.hit.path ? -1 : 1),
	);

	return {
		ordered: scored.slice(0, limit),
		rerank: {
			provider: reranker.name,
			model: response.model,
			candidates: candidates.length,
			inputTokens: response.inputTokens,
		},
	};
}
