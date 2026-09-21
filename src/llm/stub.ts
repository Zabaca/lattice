/**
 * A text provider that can be told what to say.
 *
 * `LATTICE_LLM_STUB` is a JSON array of strings, returned one per call in
 * order; once they run out the last one repeats, so a test scripting one
 * plan and one rewrite need not count the runner's calls exactly.
 *
 * It is named `stub` in the environment so it can never be selected by
 * accident.
 */

import type { Completion, TextProvider } from "./provider.js";

export const STUB_PROVIDER = "stub";
export const STUB_TEXTS_VAR = "LATTICE_LLM_STUB";

export class StubTextProvider implements TextProvider {
	readonly name = STUB_PROVIDER;
	readonly model = "stub";
	private readonly texts: string[];
	private calls = 0;

	constructor(texts: string[]) {
		this.texts = texts;
	}

	async complete(_prompt: string): Promise<Completion> {
		const text = this.texts[Math.min(this.calls, this.texts.length - 1)];
		this.calls++;
		return { text, costUsd: 0 };
	}
}

/** A malformed script is an error: a stub that said nothing would look like a model that failed to plan. */
export function stubProviderFromEnv(
	env: Record<string, string | undefined>,
): StubTextProvider {
	return new StubTextProvider(
		parseStubTexts(env[STUB_TEXTS_VAR], STUB_TEXTS_VAR),
	);
}

/**
 * The texts a stub variable scripts: a non-empty JSON array of strings.
 * `varName` is what the message blames, so the writer's stub and the text
 * provider's report their own variable in the same words.
 */
export function parseStubTexts(
	raw: string | undefined,
	varName: string,
): string[] {
	const trimmed = raw?.trim();
	if (!trimmed) {
		throw new Error(
			`The ${STUB_PROVIDER} provider needs ${varName}: a JSON array of strings.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error(`${varName} is not valid JSON.`);
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		!parsed.every((text) => typeof text === "string")
	) {
		throw new Error(`${varName} must be a non-empty JSON array of strings.`);
	}
	return parsed;
}
