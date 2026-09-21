/**
 * A web searcher that can be told what the web says.
 *
 * `LATTICE_WEB_STUB` is a JSON array of `{ title, url, highlights }`, returned
 * in that order and cut to the request's limit. `LATTICE_WEB_FAIL` names a
 * substring that makes the request throw when the query contains it, which
 * is the only way to exercise the failure path without a network to lose.
 *
 * It is named `stub` in the environment so it can never be selected by
 * accident.
 */

import type {
	WebRequest,
	WebResponse,
	WebResult,
	WebSearcher,
} from "./provider.js";

export const STUB_SEARCHER = "stub";
export const STUB_RESULTS_VAR = "LATTICE_WEB_STUB";
export const STUB_FAIL_VAR = "LATTICE_WEB_FAIL";

export class StubSearcher implements WebSearcher {
	readonly name = STUB_SEARCHER;
	private readonly results: WebResult[];
	private readonly failOn?: string;

	constructor(results: WebResult[], failOn?: string) {
		this.results = results;
		this.failOn = failOn;
	}

	async search(request: WebRequest): Promise<WebResponse> {
		if (this.failOn !== undefined && request.query.includes(this.failOn)) {
			throw new Error(`injected failure on "${this.failOn}"`);
		}
		return {
			results: this.results.slice(0, request.limit),
			cost: 0,
			searchTime: 0,
			requestId: null,
		};
	}
}

/** A malformed table is an error: a stub that answered nothing would look like a web with nothing on it. */
export function stubSearcherFromEnv(
	env: Record<string, string | undefined>,
): StubSearcher {
	const raw = env[STUB_RESULTS_VAR]?.trim();
	if (!raw) {
		throw new Error(
			`The ${STUB_SEARCHER} web searcher needs ${STUB_RESULTS_VAR}: a JSON array of { title, url, highlights }.`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${STUB_RESULTS_VAR} is not valid JSON.`);
	}

	if (!Array.isArray(parsed) || !parsed.every(isStubResult)) {
		throw new Error(
			`${STUB_RESULTS_VAR} must be a JSON array of { title, url, highlights }.`,
		);
	}

	return new StubSearcher(
		parsed.map((result) => ({
			title: result.title,
			url: result.url,
			publishedDate: null,
			author: null,
			highlights: result.highlights,
		})),
		env[STUB_FAIL_VAR]?.trim() || undefined,
	);
}

function isStubResult(
	value: unknown,
): value is { title: string; url: string; highlights: string[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { title?: unknown }).title === "string" &&
		typeof (value as { url?: unknown }).url === "string" &&
		Array.isArray((value as { highlights?: unknown }).highlights) &&
		(value as { highlights: unknown[] }).highlights.every(
			(highlight) => typeof highlight === "string",
		)
	);
}
