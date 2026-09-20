/**
 * Where vectors come from.
 *
 * Everything downstream — the embed phase, `sync`, `status` — talks to this
 * interface, so swapping the deterministic hash provider for a real local
 * model later is one module, not a rewrite.
 *
 * The default is `local`: a real model, downloaded once and run in this
 * process. The `hash` provider derives its vector from a hash of the text —
 * not semantic and not meant to be, but reproducible, needing no model on
 * disk and touching no network, which is what makes the pipeline testable.
 */

import { resolvePaths } from "../utils/paths.js";
import { createLocalProvider } from "./local.js";
import { resolveModel } from "./models.js";
import { STUB_PROVIDER, stubProviderFromEnv } from "./stub.js";

/** Dimensions the hash provider emits unless `LATTICE_EMBED_DIM` says otherwise. */
const DEFAULT_DIM = 512;

export interface EmbeddingProvider {
	/** Recorded with every vector, so a model change can be spotted later. */
	readonly model: string;
	readonly dim: number;
	/**
	 * Where this choice of model came from — an environment variable name, or
	 * a phrase like "the default". A model-change refusal prints it, because
	 * the first thing a surprised user needs is what made the change.
	 */
	readonly source: string;
	/** One vector per input, in the same order. */
	embed(texts: string[]): Promise<Float32Array[]>;
	/** Embed a search query, which some models require to be prefixed. */
	embedQuery(text: string): Promise<Float32Array>;
	/**
	 * Get whatever the provider needs before it can embed — for a local model,
	 * the weights. Optional: a provider with nothing to fetch omits it.
	 */
	ensureReady?(report?: (line: string) => void): Promise<void>;
}

/**
 * A failure the provider chose to classify.
 *
 * `retryable` is the whole point: a timeout is worth another run, a text the
 * model will never accept is not, and the embed phase treats them differently.
 */
export class EmbeddingError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "EmbeddingError";
		this.retryable = retryable;
	}
}

/**
 * Pick the provider named by the environment.
 *
 * An unrecognised name is an error rather than a silent fallback: a typo that
 * quietly indexes with the wrong model is worse than a failed command.
 */
export function selectProvider(
	env: Record<string, string | undefined>,
): EmbeddingProvider {
	const name = env.LATTICE_EMBED_PROVIDER?.trim() || "local";

	if (name === "local") {
		const { entry, source } = resolveModel(env);
		return createLocalProvider({
			entry,
			source,
			env,
			cacheDir: resolvePaths(env).models,
		});
	}

	if (name === STUB_PROVIDER) {
		return stubProviderFromEnv(env);
	}

	if (name !== "hash") {
		throw new Error(
			`Unknown embedding provider: ${name}. Known providers: local, hash, ${STUB_PROVIDER}.`,
		);
	}

	const dim = resolveDim(env);
	return new HashProvider(
		dim,
		dim === DEFAULT_DIM ? "the default" : "LATTICE_EMBED_DIM",
		env.LATTICE_EMBED_FAIL?.trim(),
	);
}

function resolveDim(env: Record<string, string | undefined>): number {
	const raw = env.LATTICE_EMBED_DIM?.trim();
	if (!raw) {
		return DEFAULT_DIM;
	}
	const dim = Number.parseInt(raw, 10);
	if (!Number.isInteger(dim) || dim <= 0) {
		throw new Error(`LATTICE_EMBED_DIM must be a positive integer, got ${raw}`);
	}
	return dim;
}

/**
 * The deterministic provider: the same text always yields the same unit
 * vector, and two different texts practically never collide.
 */
class HashProvider implements EmbeddingProvider {
	readonly model: string;
	readonly dim: number;
	readonly source: string;
	/** `retryable:<substring>` or `permanent:<substring>` — see `parseFault`. */
	private readonly fault?: { retryable: boolean; match: string };

	constructor(dim: number, source: string, fault?: string) {
		this.dim = dim;
		this.model = `hash-${dim}`;
		this.source = source;
		this.fault = parseFault(fault);
	}

	async embedQuery(text: string): Promise<Float32Array> {
		const [vector] = await this.embed([text]);
		return vector;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		return texts.map((text) => {
			if (this.fault !== undefined && text.includes(this.fault.match)) {
				throw new EmbeddingError(
					`injected ${this.fault.retryable ? "retryable" : "permanent"} failure`,
					this.fault.retryable,
				);
			}
			return hashVector(text, this.dim);
		});
	}
}

/**
 * Fault injection, spelled `<retryable|permanent>:<substring>`.
 *
 * A deterministic provider cannot fail on its own, so there would otherwise be
 * no way to exercise the failure paths without a network or a model. Anything
 * unparseable is ignored rather than breaking an ordinary run.
 */
function parseFault(
	spec: string | undefined,
): { retryable: boolean; match: string } | undefined {
	if (!spec) {
		return undefined;
	}
	const separator = spec.indexOf(":");
	if (separator === -1) {
		return undefined;
	}
	const kind = spec.slice(0, separator);
	const match = spec.slice(separator + 1);
	if (match === "" || (kind !== "retryable" && kind !== "permanent")) {
		return undefined;
	}
	return { retryable: kind === "retryable", match };
}

/**
 * A unit vector derived from the text.
 *
 * SHA-256 gives 32 bytes; a counter prefix draws as many blocks as the
 * dimension needs. Each pair of bytes becomes one component in [-1, 1), and
 * the result is L2-normalized so a dot product is a cosine similarity.
 */
function hashVector(text: string, dim: number): Float32Array {
	const vector = new Float32Array(dim);
	let filled = 0;
	let block = 0;

	while (filled < dim) {
		const digest = new Bun.CryptoHasher("sha256")
			.update(`${block}:${text}`)
			.digest();
		for (let i = 0; i + 1 < digest.length && filled < dim; i += 2) {
			const value = (digest[i] << 8) | digest[i + 1];
			vector[filled] = value / 32768 - 1;
			filled++;
		}
		block++;
	}

	let magnitude = 0;
	for (const component of vector) {
		magnitude += component * component;
	}
	magnitude = Math.sqrt(magnitude);
	if (magnitude > 0) {
		for (let i = 0; i < dim; i++) {
			vector[i] /= magnitude;
		}
	}

	return vector;
}

/** A vector as the little-endian float32 BLOB the index stores. */
export function toBlob(vector: Float32Array): Uint8Array {
	const bytes = new Uint8Array(vector.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < vector.length; i++) {
		view.setFloat32(i * 4, vector[i], true);
	}
	return bytes;
}
