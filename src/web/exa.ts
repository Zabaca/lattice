/**
 * Exa's search endpoint as a web searcher: one `POST /search` per query,
 * asking for highlights so the caller reads passages rather than pages.
 *
 * The only network call Lattice makes outside the embedding download and
 * the reranker, and only when `lattice web` is run.
 */

import type {
	WebRequest,
	WebResponse,
	WebResult,
	WebSearcher,
} from "./provider.js";

export const API_KEY_VAR = "EXA_API_KEY";
export const BASE_URL_VAR = "EXA_BASE_URL";
export const DEFAULT_BASE_URL = "https://api.exa.ai";

/** Page text is capped so one result cannot fill the reader's context. */
const TEXT_MAX_CHARACTERS = 4000;

/** The shape of Exa's response, as much of it as is read. */
interface ExaResponse {
	requestId?: string;
	searchTime?: number;
	costDollars?: { total?: number };
	results?: {
		title?: string | null;
		url: string;
		publishedDate?: string | null;
		author?: string | null;
		highlights?: string[];
		text?: string;
	}[];
}

/** What Exa says when it refuses. */
interface ExaError {
	error?: string;
	tag?: string;
}

export class ExaSearcher implements WebSearcher {
	readonly name = "exa";
	private readonly apiKey: string;
	private readonly baseUrl: string;

	constructor(options: { apiKey: string; baseUrl?: string }) {
		this.apiKey = options.apiKey;
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	}

	async search(request: WebRequest): Promise<WebResponse> {
		const body: Record<string, unknown> = {
			query: request.query,
			type: request.type,
			numResults: request.limit,
			contents: {
				highlights: true,
				...(request.text
					? { text: { maxCharacters: TEXT_MAX_CHARACTERS } }
					: {}),
			},
		};
		if (request.domains !== undefined && request.domains.length > 0) {
			body.includeDomains = request.domains;
		}
		if (request.since !== undefined) {
			body.startPublishedDate = request.since;
		}

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/search`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": this.apiKey,
				},
				body: JSON.stringify(body),
			});
		} catch (error) {
			const cause =
				error instanceof Error && error.cause instanceof Error
					? error.cause.message
					: undefined;
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not reach Exa at ${this.baseUrl}: ${cause ?? message}`,
			);
		}

		if (!response.ok) {
			throw new Error(await describeFailure(response));
		}

		const parsed = (await response.json()) as ExaResponse;
		const results: WebResult[] = (parsed.results ?? []).map((result) => ({
			title: result.title ?? null,
			url: result.url,
			publishedDate: result.publishedDate ?? null,
			author: result.author ?? null,
			highlights: result.highlights ?? [],
			...(result.text !== undefined ? { text: result.text } : {}),
		}));
		return {
			results,
			cost: parsed.costDollars?.total ?? null,
			searchTime: parsed.searchTime ?? null,
			requestId: parsed.requestId ?? null,
		};
	}
}

/**
 * A refusal in the caller's terms. A rejected key and an empty balance are
 * both the key's problem, so both name the variable; anything else is Exa's
 * own explanation, with its tag when it gives one.
 */
async function describeFailure(response: Response): Promise<string> {
	let detail: ExaError = {};
	try {
		detail = (await response.json()) as ExaError;
	} catch {
		// A body that is not JSON is described by the status alone.
	}
	const reason = detail.error ?? response.statusText ?? "";
	const tag = detail.tag !== undefined ? ` [${detail.tag}]` : "";
	if (response.status === 401) {
		return `Exa rejected ${API_KEY_VAR} (401): ${reason}${tag}`;
	}
	if (response.status === 402) {
		return `Exa has no credits left for ${API_KEY_VAR} (402): ${reason}${tag}`;
	}
	return `Exa search failed (${response.status}): ${reason}${tag}`;
}

/** The Exa searcher as the environment configures it; no key is an error. */
export function exaSearcherFromEnv(
	env: Record<string, string | undefined>,
): ExaSearcher {
	const apiKey = env[API_KEY_VAR]?.trim();
	if (!apiKey) {
		throw new Error(`lattice web needs ${API_KEY_VAR} set to an Exa API key.`);
	}
	return new ExaSearcher({
		apiKey,
		baseUrl: env[BASE_URL_VAR]?.trim() || undefined,
	});
}
