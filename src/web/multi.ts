/**
 * Several web searchers as one.
 *
 * The runner wants every leg's pages in one candidate list, so `search`
 * asks every leg and concatenates in leg order (the runner dedupes by
 * canonical URL). A leg that throws is dropped for the rest of the run and
 * its message kept; the composite itself throws only when no leg is left,
 * so the runner's existing handling of a failed web leg still applies.
 * `read` tries the legs in order, because not every leg can fetch a page.
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
	private readonly dropped: string[];

	constructor(legs: WebSearcher[], dropped: string[] = []) {
		this.legs = legs;
		this.dropped = [...dropped];
		this.name = legs.map((leg) => leg.name).join(",");
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
