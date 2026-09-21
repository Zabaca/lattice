/**
 * Several web searchers as one.
 *
 * The runner wants every leg's pages in one candidate list, so `search`
 * asks every leg and concatenates in leg order (the runner dedupes by
 * canonical URL). A leg that throws is dropped for the rest of the run and
 * its message kept; the composite itself throws only when no leg is left,
 * so the runner's existing handling of a failed web leg still applies.
 * `read` tries the legs in order, because not every leg can fetch a page.
 *
 * Some legs are `later` ones: held back until `escalate()` is called, which
 * the runner does from its first rewrite, or until every other leg has
 * failed in one search. A leg that is slow or dear is paid for only on a
 * round the cheap legs have already failed.
 */

import type {
	WebPage,
	WebRequest,
	WebResponse,
	WebSearcher,
} from "./provider.js";

export class MultiSearcher implements WebSearcher {
	readonly name: string;
	private legs: WebSearcher[];
	private later: WebSearcher[];
	private readonly dropped: string[];
	/** Later legs that could not be built: a reason only once escalation asks for them. */
	private laterDropped: string[];

	constructor(
		legs: WebSearcher[],
		dropped: string[] = [],
		later: { legs: WebSearcher[]; dropped: string[] } = {
			legs: [],
			dropped: [],
		},
	) {
		this.legs = legs;
		this.dropped = [...dropped];
		this.later = [...later.legs];
		this.laterDropped = [...later.dropped];
		this.name = [...legs, ...later.legs].map((leg) => leg.name).join(",");
	}

	/** Bring the later legs into every search from now on. A second call is a no-op. */
	escalate(): void {
		this.legs.push(...this.later);
		this.dropped.push(...this.laterDropped);
		this.later = [];
		this.laterDropped = [];
	}

	/** The legs the next search asks, by name. */
	active(): string[] {
		return this.legs.map((leg) => leg.name);
	}

	async search(request: WebRequest): Promise<WebResponse> {
		const settled = await Promise.allSettled(
			this.legs.map((leg) => leg.search(request)),
		);
		const remaining: WebSearcher[] = [];
		const responses: WebResponse[] = [];
		settled.forEach((outcome, index) => {
			const leg = this.legs[index];
			if (outcome.status === "fulfilled") {
				remaining.push(leg);
				responses.push(outcome.value);
			} else {
				this.dropped.push(`${leg.name}: ${describe(outcome.reason)}`);
			}
		});
		this.legs = remaining;
		if (responses.length === 0) {
			// Every leg of this round failed. Legs held back for a later round
			// are the fallback now: waiting for a rewrite would leave the round
			// with no web at all.
			if (this.later.length > 0 || this.laterDropped.length > 0) {
				this.escalate();
				if (this.legs.length > 0) {
					return this.search(request);
				}
			}
			throw new Error(this.dropped.join("; "));
		}
		let cost: number | null = null;
		for (const response of responses) {
			if (response.cost !== null) {
				cost = (cost ?? 0) + response.cost;
			}
		}
		return {
			results: responses.flatMap((response, index) =>
				response.results.map((result) => ({
					...result,
					leg: remaining[index].name,
				})),
			),
			cost,
			searchTime: null,
			requestId: null,
		};
	}

	async read(url: string): Promise<WebPage> {
		let last: unknown = new Error("no web searcher can read pages");
		for (const leg of this.legs) {
			try {
				return await leg.read(url);
			} catch (error) {
				last = error;
			}
		}
		throw last;
	}

	/** Why each dropped leg was dropped, in the order it happened. */
	reasons(): string[] {
		return [...this.dropped];
	}
}

function describe(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}
