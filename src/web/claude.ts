/**
 * Claude's own WebSearch tool as a web searcher.
 *
 * The runner already runs Haiku through the Agent SDK to plan its queries;
 * the same call with the SDK's WebSearch tool is a second search engine
 * beside Exa, and the one that found the pages Exa missed when an agent
 * searched by hand. Haiku searches and summarises; the judge reads what it
 * found like any other web candidate.
 *
 * URLs are grounded: a page is returned only when its URL appeared in a
 * WebSearch tool result, so a URL the model invented is dropped. The title
 * is the tool's, the one highlight is the model's sentence about the page.
 * The tool has no search type, domain filter or date bound, so `type`,
 * `domains` and `since` are ignored, and it cannot fetch a page, so `read`
 * throws: the composite searcher routes reads to a leg that can.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { WebSearchOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import {
	type ClaudeEnvironment,
	claudeEnvironment,
	LLM_MODEL_VAR,
	minimalOptions,
} from "../llm/claude.js";
import type {
	WebPage,
	WebRequest,
	WebResponse,
	WebResult,
	WebSearcher,
} from "./provider.js";

export const CLAUDE_SEARCHER = "claude";

/**
 * The model that searches, when nothing names one. It is not the planner's:
 * this leg summarises tool results rather than synthesising anything, and it
 * already costs about fifteen seconds and a cent or two a query.
 */
export const DEFAULT_SEARCH_MODEL = "claude-haiku-4-5";

/** A search, a second search when the first was thin, and the answer. */
const MAX_TURNS = 3;

/** A page the tool returned: what the model may cite. */
export interface GroundedLink {
	title: string;
	url: string;
}

export class ClaudeSearcher implements WebSearcher {
	readonly name = CLAUDE_SEARCHER;
	private readonly environment: ClaudeEnvironment;

	constructor(environment: ClaudeEnvironment) {
		this.environment = environment;
	}

	async search(request: WebRequest): Promise<WebResponse> {
		const prompt =
			`Search the web for: ${request.query}\n` +
			`Return JSON only: {"results":[{"title":"...","url":"...","snippet":"..."}]}, ` +
			`up to ${request.limit} results, each url one the search returned, ` +
			`snippet a sentence the page says about the query.`;
		const options = minimalOptions(
			this.environment.model,
			this.environment.env,
			this.environment.executable,
		);
		const turn = query({
			prompt,
			options: {
				...options,
				tools: ["WebSearch"],
				allowedTools: ["WebSearch"],
				maxTurns: MAX_TURNS,
			},
		});
		const grounded: GroundedLink[] = [];
		const texts: string[] = [];
		let cost: number | null = null;
		for await (const message of turn) {
			if (message.type === "user") {
				grounded.push(...linksIn(message.tool_use_result));
			} else if (message.type === "assistant") {
				for (const block of message.message.content) {
					if (block.type === "text") {
						texts.push(block.text);
					}
				}
			} else if (message.type === "result") {
				cost = message.total_cost_usd;
				if (message.subtype !== "success") {
					throw new Error(`Claude did not search: ${message.subtype}`);
				}
				if (message.is_error) {
					throw new Error(`Claude did not search: ${message.result}`);
				}
			}
		}
		return {
			results: resultsFrom(texts.join("\n"), grounded).slice(0, request.limit),
			cost,
			searchTime: null,
			requestId: null,
		};
	}

	async read(_url: string): Promise<WebPage> {
		throw new Error("the claude searcher cannot read pages");
	}
}

/** The links in one WebSearch tool result, when that is what the message carries. */
function linksIn(result: unknown): GroundedLink[] {
	const output = result as Partial<WebSearchOutput> | undefined;
	if (output === undefined || !Array.isArray(output.results)) {
		return [];
	}
	const links: GroundedLink[] = [];
	for (const entry of output.results) {
		if (typeof entry === "string" || !Array.isArray(entry.content)) {
			continue;
		}
		for (const hit of entry.content) {
			if (typeof hit?.url === "string") {
				links.push({ title: String(hit.title ?? ""), url: hit.url });
			}
		}
	}
	return links;
}

/**
 * The model's JSON answer filtered to the pages the tool actually returned,
 * in the model's order, one page once. Prose or a code fence around the
 * JSON is tolerated; no JSON, or JSON without a `results` array, is no
 * results.
 */
export function resultsFrom(
	text: string,
	grounded: GroundedLink[],
): WebResult[] {
	const json = text.match(/\{[\s\S]*\}/)?.[0];
	if (json === undefined) {
		return [];
	}
	let parsed: { results?: unknown };
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed.results)) {
		return [];
	}
	const byUrl = new Map<string, GroundedLink>();
	for (const link of grounded) {
		byUrl.set(sameUrl(link.url), link);
	}
	const seen = new Set<string>();
	const results: WebResult[] = [];
	for (const entry of parsed.results) {
		const url = (entry as { url?: unknown })?.url;
		if (typeof url !== "string") {
			continue;
		}
		const key = sameUrl(url);
		const link = byUrl.get(key);
		if (link === undefined || seen.has(key)) {
			continue;
		}
		seen.add(key);
		const snippet = (entry as { snippet?: unknown }).snippet;
		results.push({
			title: link.title || null,
			url: link.url,
			publishedDate: null,
			author: null,
			highlights:
				typeof snippet === "string" && snippet !== "" ? [snippet] : [],
		});
	}
	return results;
}

/** A model rewrites a trailing slash or a fragment freely; neither changes the page. */
function sameUrl(url: string): string {
	return url.trim().replace(/#.*$/, "").replace(/\/+$/, "");
}

/** The Claude searcher as the environment configures it; no credential is an error. */
export function claudeSearcherFromEnv(
	env: Record<string, string | undefined>,
): ClaudeSearcher {
	const environment = claudeEnvironment(env, "The claude web searcher");
	return new ClaudeSearcher({
		...environment,
		model: env[LLM_MODEL_VAR]?.trim() || DEFAULT_SEARCH_MODEL,
	});
}
