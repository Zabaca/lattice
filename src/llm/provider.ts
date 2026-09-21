/**
 * Where the runner gets text from.
 *
 * The search loop is driven by code and judged by Jev; a language model is
 * called only in the two states that need prose turned into queries — `plan`
 * and `rewrite`. This is that seam, the same shape as the reranker's and the
 * web searcher's: a real provider behind a credential, and a stub the test
 * suite can script.
 *
 * `claude` is the real one, the Claude Agent SDK with everything but the model
 * switched off. `stub` returns whatever `LATTICE_LLM_STUB` declares, in order.
 */

import { claudeProviderFromEnv } from "./claude.js";
import { STUB_PROVIDER, stubProviderFromEnv } from "./stub.js";

export const LLM_PROVIDER_VAR = "LATTICE_LLM_PROVIDER";

export interface Completion {
	text: string;
	/** What the call cost in dollars, when the provider says. */
	costUsd: number;
}

export interface TextProvider {
	readonly name: string;
	readonly model: string;
	complete(prompt: string): Promise<Completion>;
}

/**
 * The provider the environment names; nothing set means Claude.
 *
 * An unknown name, `claude` with no credential and a malformed stub all
 * throw: the runner cannot plan without one, so there is nothing to fall
 * back to and no reason to be quiet.
 */
export function selectTextProvider(
	env: Record<string, string | undefined>,
): TextProvider {
	const name = env[LLM_PROVIDER_VAR]?.trim() || "claude";
	if (name === "claude") {
		return claudeProviderFromEnv(env);
	}
	if (name === STUB_PROVIDER) {
		return stubProviderFromEnv(env);
	}
	throw new Error(
		`Unknown text provider in ${LLM_PROVIDER_VAR}: ${name}. Known providers: claude, ${STUB_PROVIDER}.`,
	);
}

/**
 * The queries a completion holds: a JSON `{queries}` object when the model
 * obeyed, otherwise one query per non-empty line. None at all is an error,
 * because a search state with nothing to search is not a state the runner
 * can be in.
 */
export function queriesFrom(text: string): string[] {
	const json = text.match(/\{[\s\S]*\}/)?.[0];
	if (json !== undefined) {
		try {
			const parsed = JSON.parse(json);
			if (Array.isArray(parsed.queries)) {
				const queries = parsed.queries
					.map((query: unknown) => String(query).trim())
					.filter((query: string) => query !== "");
				if (queries.length > 0) {
					return queries;
				}
			}
		} catch {}
	}
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length === 0) {
		throw new Error("The text provider returned no queries.");
	}
	return lines;
}
