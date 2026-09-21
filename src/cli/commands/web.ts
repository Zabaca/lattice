import {
	selectWebSearcher,
	WEB_SEARCH_TYPES,
	type WebResult,
	type WebSearcher,
	type WebSearchType,
} from "../../web/provider.js";
import { count, text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";

/** Results returned when `--limit` is not given. */
const DEFAULT_LIMIT = 10;
/** The most Exa returns in one request. */
const MAX_LIMIT = 100;
const DEFAULT_TYPE: WebSearchType = "auto";

/**
 * Search the web for the `/research` skill.
 *
 * One request, results printed with the passages the service picked out, so
 * the reader sees what each page says without fetching it. No fallback: the
 * skill decides what to do when this fails.
 */
export async function runWeb(context: CommandContext): Promise<CommandOutput> {
	let limit: number;
	let type: WebSearchType;
	let since: string | undefined;
	let searcher: WebSearcher;
	try {
		limit = count(context.flags.limit, DEFAULT_LIMIT, "--limit");
		if (limit > MAX_LIMIT) {
			throw new Error(`--limit must be at most ${MAX_LIMIT}, got: ${limit}`);
		}
		type = searchType(context.flags.type);
		since = isoDate(context.flags.since);
		searcher = selectWebSearcher(context.env);
	} catch (error) {
		return { code: 1, stderr: (error as Error).message };
	}

	const query = context.positionals[0];
	const domains = text(context.flags.domain)
		?.split(",")
		.map((domain) => domain.trim())
		.filter((domain) => domain !== "");
	const response = await searcher.search({
		query,
		type,
		limit,
		domains,
		since,
		text: context.flags.text !== undefined,
	});

	if (context.flags.json !== undefined) {
		return {
			code: 0,
			stdout: `${JSON.stringify({
				query,
				type,
				results: response.results,
				cost: response.cost,
				searchTime: response.searchTime,
				requestId: response.requestId,
			})}\n`,
		};
	}
	return { code: 0, stdout: render(response.results) };
}

function searchType(flag: string | true | undefined): WebSearchType {
	const value = text(flag);
	if (value === undefined) {
		return DEFAULT_TYPE;
	}
	if ((WEB_SEARCH_TYPES as readonly string[]).includes(value)) {
		return value as WebSearchType;
	}
	throw new Error(
		`--type expects one of ${WEB_SEARCH_TYPES.join(", ")}, got: ${flag}`,
	);
}

/** `--since` as the ISO date Exa expects; anything it cannot parse is refused. */
function isoDate(flag: string | true | undefined): string | undefined {
	if (flag === undefined) {
		return undefined;
	}
	const at = typeof flag === "string" ? Date.parse(flag) : Number.NaN;
	if (Number.isNaN(at)) {
		throw new Error(`--since expects a date, got: ${flag}`);
	}
	return new Date(at).toISOString();
}

function render(results: WebResult[]): string {
	if (results.length === 0) {
		return "No results.\n";
	}
	const lines: string[] = [];
	results.forEach((result, index) => {
		const when =
			result.publishedDate === null ? "" : ` (${result.publishedDate})`;
		lines.push(
			`${index + 1}. ${result.title ?? "(untitled)"} — ${result.url}${when}`,
		);
		for (const highlight of result.highlights) {
			lines.push(`   ${highlight.replace(/\s+/g, " ").trim()}`);
		}
		if (result.text !== undefined) {
			lines.push("");
			lines.push(
				...result.text
					.trim()
					.split("\n")
					.map((line) => `   ${line}`),
			);
		}
		lines.push("");
	});
	return lines.join("\n");
}
