/**
 * Who writes the document.
 *
 * `lattice research` calls a model once, at the end, to turn the passages
 * the judge kept into an OKF document — or into a new version of one that
 * exists. This is that seam, the same shape as the text provider's: a real
 * model behind a credential, and a stub the test suite can script.
 *
 * It is a seam of its own rather than the planner's because the two want
 * different models. Haiku's queries were as good as Opus's; a document is
 * where the model shows, so the writer defaults to Sonnet. And it reads its
 * own stub variable, so a test's query script and its document script are
 * not one positional list.
 */

import { ClaudeProvider, claudeEnvironment } from "../llm/claude.js";
import type { Completion, TextProvider } from "../llm/provider.js";
import {
	parseStubTexts,
	STUB_PROVIDER,
	StubTextProvider,
} from "../llm/stub.js";

export const WRITE_PROVIDER_VAR = "LATTICE_WRITE_PROVIDER";
export const WRITE_MODEL_VAR = "LATTICE_WRITE_MODEL";
export const WRITE_STUB_VAR = "LATTICE_WRITE_STUB";
export const DEFAULT_WRITE_MODEL = "claude-sonnet-5";
/**
 * The CLI's default output ceiling would cut an `extend` that echoes a
 * long document; this is what the forwarded environment raises it to.
 */
const MAX_OUTPUT_TOKENS = "16000";
/** What one document is allowed to cost. */
const MAX_BUDGET_USD = 1.0;

export interface Writer {
	readonly name: string;
	readonly model: string;
	write(prompt: string): Promise<Completion>;
}

/**
 * The writer the environment names; nothing set means Claude on the
 * default model. An unknown name, `claude` with no credential and a
 * malformed stub all throw: a research run with no writer cannot finish.
 */
export function selectWriter(env: Record<string, string | undefined>): Writer {
	const name = env[WRITE_PROVIDER_VAR]?.trim() || "claude";
	if (name === "claude") {
		const environment = claudeEnvironment(env, "The claude writer");
		const claude = new ClaudeProvider({
			model: env[WRITE_MODEL_VAR]?.trim() || DEFAULT_WRITE_MODEL,
			env: {
				...environment.env,
				CLAUDE_CODE_MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
			},
			executable: environment.executable,
			maxBudgetUsd: MAX_BUDGET_USD,
		});
		return writerOver(claude);
	}
	if (name === STUB_PROVIDER) {
		return writerOver(
			new StubTextProvider(parseStubTexts(env[WRITE_STUB_VAR], WRITE_STUB_VAR)),
		);
	}
	throw new Error(
		`Unknown writer in ${WRITE_PROVIDER_VAR}: ${name}. Known writers: claude, ${STUB_PROVIDER}.`,
	);
}

/** A text provider as a writer: the same call under the name the loop uses. */
function writerOver(provider: TextProvider): Writer {
	return {
		name: provider.name,
		model: provider.model,
		write: (prompt) => provider.complete(prompt),
	};
}
