/**
 * A provider that can be told what means what.
 *
 * The hash provider is deterministic but not semantic: two texts that say the
 * same thing in different words land in unrelated directions. That makes it
 * impossible to demonstrate the one thing a vector leg exists for — finding a
 * document whose words the query never used.
 *
 * So this provider takes the meaning as input. `LATTICE_EMBED_STUB` is a JSON
 * array of groups, each group a list of phrases declared to mean the same
 * thing, and a text's vector is one dimension per group whose phrase it
 * mentions. Two texts sharing no words but mentioning the same group are
 * exactly parallel; a text mentioning none is the zero vector, which is near
 * nothing.
 *
 * It is for tests and for demonstrating retrieval behavior without a model on
 * disk. It is named `stub` in the environment, so it can never be selected by
 * accident.
 */

import type { EmbeddingProvider } from "./provider.js";

export const STUB_PROVIDER = "stub";
export const STUB_GROUPS_VAR = "LATTICE_EMBED_STUB";

export class StubProvider implements EmbeddingProvider {
	readonly model: string;
	readonly dim: number;
	readonly source = STUB_GROUPS_VAR;
	/** One list of equivalent phrases per dimension, lower-cased for matching. */
	private readonly groups: string[][];

	constructor(groups: string[][]) {
		this.groups = groups.map((group) =>
			group.map((phrase) => phrase.toLowerCase()),
		);
		this.dim = Math.max(this.groups.length, 1);
		this.model = `stub-${this.dim}`;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		return texts.map((text) => this.vector(text));
	}

	/** Declared meaning is symmetric: a question is matched like a passage. */
	embedQuery(texts: string[]): Promise<Float32Array[]> {
		return this.embed(texts);
	}

	private vector(text: string): Float32Array {
		const haystack = text.toLowerCase();
		const vector = new Float32Array(this.dim);

		let hits = 0;
		this.groups.forEach((group, index) => {
			if (group.some((phrase) => haystack.includes(phrase))) {
				vector[index] = 1;
				hits++;
			}
		});

		// Unit length, so a dot product is a cosine. A text that mentions no
		// group stays at zero: it is not near anything, including itself.
		if (hits > 0) {
			const magnitude = Math.sqrt(hits);
			for (let i = 0; i < this.dim; i++) {
				vector[i] /= magnitude;
			}
		}

		return vector;
	}
}

/**
 * Read the groups from the environment.
 *
 * A malformed value is an error rather than an empty provider: a stub that
 * silently embeds everything as zero would look like a model that simply
 * finds nothing.
 */
export function stubProviderFromEnv(
	env: Record<string, string | undefined>,
): StubProvider {
	const raw = env[STUB_GROUPS_VAR]?.trim();
	if (!raw) {
		throw new Error(
			`The ${STUB_PROVIDER} provider needs ${STUB_GROUPS_VAR}: a JSON array of phrase groups.`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${STUB_GROUPS_VAR} is not valid JSON.`);
	}

	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(group) =>
				Array.isArray(group) &&
				group.every((phrase) => typeof phrase === "string"),
		)
	) {
		throw new Error(
			`${STUB_GROUPS_VAR} must be a JSON array of arrays of strings.`,
		);
	}

	return new StubProvider(parsed as string[][]);
}
