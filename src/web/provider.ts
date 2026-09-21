/**
 * Where `lattice web` gets its results from.
 *
 * The command exists for one caller, the `/research` skill's web step, and
 * it does not degrade: there is nothing inside the command to fall back to,
 * so a searcher that cannot be built or a request that fails is an error the
 * skill sees and works around itself.
 *
 * `exa` is the real one, behind `EXA_API_KEY`. `stub` returns whatever
 * `LATTICE_WEB_STUB` declares, which is what lets the test suite show the
 * rendering and the failure paths without a key or a network.
 */

import { exaSearcherFromEnv } from "./exa.js";
import { STUB_SEARCHER, stubSearcherFromEnv } from "./stub.js";

export const WEB_PROVIDER_VAR = "LATTICE_WEB_PROVIDER";

/** Exa's search types, in its own words; `auto` is what it recommends. */
export const WEB_SEARCH_TYPES = [
	"instant",
	"fast",
	"auto",
	"deep-lite",
	"deep",
	"deep-reasoning",
] as const;
export type WebSearchType = (typeof WEB_SEARCH_TYPES)[number];

export interface WebRequest {
	query: string;
	type: WebSearchType;
	limit: number;
	/** Only pages from these hosts, when given. */
	domains?: string[];
	/** Only pages published on or after this ISO date, when given. */
	since?: string;
	/** Page text beside the highlights, which costs context to read. */
	text: boolean;
}

export interface WebResult {
	title: string | null;
	url: string;
	publishedDate: string | null;
	author: string | null;
	/** The passages the service picked out as answering the query. */
	highlights: string[];
	text?: string;
}

export interface WebResponse {
	results: WebResult[];
	/** What the request cost in dollars, when the service says. */
	cost: number | null;
	/** The service's own timing in milliseconds, when it says. */
	searchTime: number | null;
	requestId: string | null;
}

export interface WebSearcher {
	readonly name: string;
	search(request: WebRequest): Promise<WebResponse>;
}

/**
 * The searcher the environment names; nothing set means Exa.
 *
 * An unknown name, `exa` with no key and a malformed stub all throw: a
 * command with nothing to fall back to has no reason to be quiet about it.
 */
export function selectWebSearcher(
	env: Record<string, string | undefined>,
): WebSearcher {
	const name = env[WEB_PROVIDER_VAR]?.trim() || "exa";
	if (name === "exa") {
		return exaSearcherFromEnv(env);
	}
	if (name === STUB_SEARCHER) {
		return stubSearcherFromEnv(env);
	}
	throw new Error(
		`Unknown web searcher in ${WEB_PROVIDER_VAR}: ${name}. Known searchers: exa, ${STUB_SEARCHER}.`,
	);
}
