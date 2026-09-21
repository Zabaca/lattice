/**
 * Where `lattice web` gets its results from.
 *
 * The command exists for one caller, the `/research` skill's web step, and
 * it does not degrade: there is nothing inside the command to fall back to,
 * so a searcher that cannot be built or a request that fails is an error the
 * skill sees and works around itself.
 *
 * `exa` is the real one, behind `EXA_API_KEY`. `claude` is Claude's own
 * WebSearch tool through the Agent SDK. `stub` returns whatever
 * `LATTICE_WEB_STUB` declares, which is what lets the test suite show the
 * rendering and the failure paths without a key or a network.
 *
 * `LATTICE_WEB_PROVIDER` is a comma-separated list of those: one name is one
 * searcher, several are a `MultiSearcher` that asks every leg. Nothing set
 * means Exa. `lattice run` also reads `LATTICE_WEB_ESCALATE`, the legs it
 * adds once a round has failed to satisfy the judge; with neither set that
 * is Claude, so the slow, dear leg is paid for only after the cheap one has
 * come up short.
 */

import { CLAUDE_SEARCHER, claudeSearcherFromEnv } from "./claude.js";
import { exaSearcherFromEnv } from "./exa.js";
import { MultiSearcher } from "./multi.js";
import { STUB_SEARCHER, stubSearcherFromEnv } from "./stub.js";

export const WEB_PROVIDER_VAR = "LATTICE_WEB_PROVIDER";
/** Legs `lattice run` adds from its first rewrite on; nothing else reads it. */
export const WEB_ESCALATE_VAR = "LATTICE_WEB_ESCALATE";

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
	/** Which leg found the page, when several were searched. */
	leg?: string;
}

export interface WebResponse {
	results: WebResult[];
	/** What the request cost in dollars, when the service says. */
	cost: number | null;
	/** The service's own timing in milliseconds, when it says. */
	searchTime: number | null;
	requestId: string | null;
}

/** One page in full, for the runner's `read` state. */
export interface WebPage {
	url: string;
	text: string;
	/** What the fetch cost in dollars, when the service says. */
	cost: number | null;
}

export interface WebSearcher {
	readonly name: string;
	search(request: WebRequest): Promise<WebResponse>;
	/** The page's text, when the searcher can fetch it. Throws when it cannot. */
	read(url: string): Promise<WebPage>;
}

const KNOWN_SEARCHERS = ["exa", CLAUDE_SEARCHER, STUB_SEARCHER];

/** A name that is not a searcher: a mistake in the environment, never a reason to search less. */
export class WebConfigurationError extends Error {}

/**
 * The searchers the environment names, or `defaultLegs` when it names none.
 *
 * An unknown name anywhere in the list throws, naming the known ones. A
 * single leg that cannot be built (`exa` with no key, a malformed stub)
 * throws as well: a command with nothing to fall back to has no reason to
 * be quiet about it. With several legs, the ones that build make the
 * searcher and the ones that do not are remembered as reasons; only when
 * none builds does the call throw, with every reason.
 *
 * `escalation` names legs held back for `MultiSearcher.escalate()`: a
 * literal list, or `null` to read `LATTICE_WEB_ESCALATE` with
 * `defaultEscalation` standing in when both that and `LATTICE_WEB_PROVIDER`
 * are unset. An explicit `LATTICE_WEB_PROVIDER` with no
 * `LATTICE_WEB_ESCALATE` escalates to nothing: the caller said what to
 * search. A later leg that cannot be built is a reason only once escalation
 * asks for it.
 */
export function selectWebSearcher(
	env: Record<string, string | undefined>,
	defaultLegs = "exa",
	escalation: { defaultEscalation: string } | null = null,
): WebSearcher {
	const configured = env[WEB_PROVIDER_VAR]?.trim();
	const names = legNames(configured || defaultLegs);
	const laterNames =
		escalation === null
			? []
			: legNames(
					env[WEB_ESCALATE_VAR]?.trim() ||
						(configured ? "" : escalation.defaultEscalation),
				).filter((name) => !names.includes(name));
	for (const name of [...names, ...laterNames]) {
		if (!KNOWN_SEARCHERS.includes(name)) {
			throw new WebConfigurationError(
				`Unknown web searcher in ${WEB_PROVIDER_VAR}: ${name}. Known searchers: ${KNOWN_SEARCHERS.join(", ")}.`,
			);
		}
	}
	if (names.length === 1 && laterNames.length === 0) {
		return buildSearcher(names[0], env);
	}
	const legs: WebSearcher[] = [];
	const reasons: string[] = [];
	for (const name of names) {
		try {
			legs.push(buildSearcher(name, env));
		} catch (error) {
			reasons.push(`${name}: ${(error as Error).message}`);
		}
	}
	if (legs.length === 0) {
		throw new Error(reasons.join("; "));
	}
	const later: WebSearcher[] = [];
	const laterReasons: string[] = [];
	for (const name of laterNames) {
		try {
			later.push(buildSearcher(name, env));
		} catch (error) {
			laterReasons.push(`${name}: ${(error as Error).message}`);
		}
	}
	return new MultiSearcher(legs, reasons, {
		legs: later,
		dropped: laterReasons,
	});
}

function legNames(list: string): string[] {
	return list
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
}

function buildSearcher(
	name: string,
	env: Record<string, string | undefined>,
): WebSearcher {
	if (name === "exa") {
		return exaSearcherFromEnv(env);
	}
	if (name === CLAUDE_SEARCHER) {
		return claudeSearcherFromEnv(env);
	}
	return stubSearcherFromEnv(env);
}
