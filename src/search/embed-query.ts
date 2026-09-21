/**
 * The query as a vector, or the reason there is none.
 *
 * A search must still answer when no model will: a provider that cannot be
 * selected or cannot embed costs the semantic leg, not the command. The reason
 * travels with the result so the caller can say the answer is weaker than
 * usual rather than quietly returning a worse one. `search` and `run` share
 * it so the two embed a question the same way.
 */

import { selectProvider } from "../embed/provider.js";
import type { VectorSpace } from "../embed/state.js";
import type { SemanticInput } from "./vector.js";

export interface EmbeddedQuery {
	semantic?: SemanticInput;
	reason?: string;
	/** The space the query was embedded into, when there was one. */
	space?: VectorSpace;
	/** Where that model name came from, for the model-change message. */
	source?: string;
}

export async function embedQuery(
	query: string,
	env: Record<string, string | undefined>,
	report: (line: string) => void,
): Promise<EmbeddedQuery> {
	try {
		const provider = selectProvider(env, report);
		const space = { model: provider.model, dim: provider.dim };
		// `embedQuery`, not `embed`: an asymmetric model is trained to be told
		// that this is a question rather than a passage, and a query embedded
		// as a passage lands in the wrong part of the space.
		const [vector] = await provider.embedQuery([query]);
		return {
			semantic: { vector, model: provider.model, dim: provider.dim },
			space,
			source: provider.source,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { reason: `the query could not be embedded: ${message}` };
	}
}
