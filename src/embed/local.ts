/**
 * Embeddings computed here, in this process.
 *
 * No daemon, no API key, no request leaving the machine after the model is on
 * disk. The model is an ONNX graph run by `onnxruntime-node` through
 * transformers.js; the first use downloads it into the Lattice home directory
 * and every later use reads it from there.
 *
 * The import is deferred: `onnxruntime-node` loads ~90 MB of native library,
 * and a `lattice status` that never embeds anything should not pay for it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ModelEntry, modelIdentity } from "./models.js";
import { EmbeddingError, type EmbeddingProvider } from "./provider.js";

/** A line of download progress, so a first run is not a silent two minutes. */
export type ProgressReporter = (line: string) => void;

export interface LocalProviderOptions {
	entry: ModelEntry;
	/** Where the choice of model came from, for a model-change message. */
	source: string;
	/** The environment: cache location, offline switch, mirror. */
	env: Record<string, string | undefined>;
	/** `<LATTICE_HOME>/models`, where downloads are cached. */
	cacheDir: string;
}

export function createLocalProvider(
	options: LocalProviderOptions,
): EmbeddingProvider {
	return new LocalProvider(options);
}

/** Minimal shape of what transformers.js hands back; avoids importing types eagerly. */
type FeatureExtractor = (
	texts: string[],
	options: { pooling: "mean" | "cls"; normalize: boolean },
) => Promise<{ dims: number[]; data: ArrayLike<number> }>;

class LocalProvider implements EmbeddingProvider {
	readonly model: string;
	readonly dim: number;
	readonly source: string;
	private readonly options: LocalProviderOptions;
	/** The load is shared: concurrent callers must not download twice. */
	private extractor?: Promise<FeatureExtractor>;

	constructor(options: LocalProviderOptions) {
		this.options = options;
		this.model = modelIdentity(options.entry);
		this.dim = options.entry.dim;
		this.source = options.source;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		return this.run(
			texts.map((text) => this.options.entry.documentPrefix + text),
		);
	}

	async embedQuery(text: string): Promise<Float32Array> {
		const [vector] = await this.run([this.options.entry.queryPrefix + text]);
		return vector;
	}

	/**
	 * Make sure the model is on disk, downloading it if it is not.
	 *
	 * Called by `init` and before a sync's embed phase, so the download is a
	 * step the user watches rather than a stall in the middle of indexing.
	 */
	async ensureReady(report?: ProgressReporter): Promise<void> {
		await this.load(report);
	}

	private async run(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) {
			return [];
		}
		const extract = await this.load();
		const entry = this.options.entry;

		let output: { dims: number[]; data: ArrayLike<number> };
		try {
			output = await extract(texts, {
				pooling: entry.pooling,
				normalize: !entry.matryoshka,
			});
		} catch (error) {
			// A text the model cannot process at all is not worth retrying;
			// anything else (a transient allocation failure, say) is.
			throw new EmbeddingError(
				error instanceof Error ? error.message : String(error),
				false,
			);
		}

		const native = output.dims[output.dims.length - 1];
		if (native !== entry.nativeDim) {
			throw new EmbeddingError(
				`${entry.name} produced ${native}-dimensional vectors; the registry says ${entry.nativeDim}.`,
				false,
			);
		}

		const vectors: Float32Array[] = [];
		for (let i = 0; i < texts.length; i++) {
			const full = Float32Array.from(
				Array.prototype.slice.call(output.data, i * native, (i + 1) * native),
			);
			vectors.push(entry.matryoshka ? truncate(full, entry.dim) : full);
		}
		return vectors;
	}

	private load(report?: ProgressReporter): Promise<FeatureExtractor> {
		if (this.extractor === undefined) {
			this.extractor = this.build(report);
		}
		return this.extractor;
	}

	private async build(report?: ProgressReporter): Promise<FeatureExtractor> {
		const entry = this.options.entry;
		const { pipeline, env } = await import("@huggingface/transformers");

		env.cacheDir = this.options.cacheDir;
		env.allowLocalModels = true;

		// A model the user placed themselves. Used as-is, with the network
		// switched off, because someone who pre-places a model is usually
		// someone who cannot reach the hub at all.
		const placed = this.options.env.LATTICE_MODEL_DIR?.trim() || undefined;
		if (placed !== undefined) {
			env.localModelPath = placed;
			env.allowRemoteModels = false;
		} else {
			env.localModelPath = join(this.options.cacheDir, "local");
			env.allowRemoteModels = !isOffline(this.options.env);
		}

		const mirror = this.options.env.HF_ENDPOINT?.trim();
		if (mirror) {
			env.remoteHost = mirror.endsWith("/") ? mirror : `${mirror}/`;
		}

		// transformers.js reports a 'download' for a file it reads out of its
		// own cache, so the only reliable way to know whether anything came
		// over the network is to look before it starts.
		const cached =
			placed !== undefined || existsSync(join(env.cacheDir, entry.repo));
		const reported = new Set<string>();
		try {
			return (await pipeline("feature-extraction", entry.repo, {
				dtype: entry.dtype,
				progress_callback: (event: unknown) => {
					if (cached) {
						return;
					}
					const line = progressLine(event, reported);
					if (line !== undefined) {
						report?.(line);
					}
				},
			})) as unknown as FeatureExtractor;
		} catch (error) {
			throw new Error(unavailableMessage(this.options, error));
		}
	}
}

/** `HF_HUB_OFFLINE` in any of the spellings the ecosystem accepts. */
function isOffline(env: Record<string, string | undefined>): boolean {
	const raw = env.HF_HUB_OFFLINE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * One line per file that finished arriving.
 *
 * Byte-level progress would need a terminal to rewrite; a line per file is
 * honest in a log, a pipe and a terminal alike.
 */
function progressLine(
	event: unknown,
	reported: Set<string>,
): string | undefined {
	if (typeof event !== "object" || event === null) {
		return undefined;
	}
	const { status, file } = event as { status?: string; file?: string };
	if (status !== "done" || typeof file !== "string" || reported.has(file)) {
		return undefined;
	}
	reported.add(file);
	return `  downloaded ${file}`;
}

function unavailableMessage(
	options: LocalProviderOptions,
	error: unknown,
): string {
	const detail = error instanceof Error ? error.message : String(error);
	const placed = options.env.LATTICE_MODEL_DIR?.trim();
	const where = placed
		? `LATTICE_MODEL_DIR (${placed})`
		: `the model cache (${options.cacheDir})`;
	return (
		`Could not load the embedding model ${options.entry.repo} from ${where}.\n` +
		(isOffline(options.env)
			? "HF_HUB_OFFLINE is set, so nothing was downloaded. Unset it, or place the model directory yourself and point LATTICE_MODEL_DIR at its parent.\n"
			: "Check the network, or place the model directory yourself and point LATTICE_MODEL_DIR at its parent.\n") +
		detail
	);
}

/**
 * The first `dim` components, re-normalised.
 *
 * Only legitimate for a matryoshka model: the prefix of its vector is itself
 * a vector, but it is no longer unit length once cut, and a cosine similarity
 * computed as a dot product would be wrong without this.
 */
function truncate(vector: Float32Array, dim: number): Float32Array {
	const cut = vector.subarray(0, dim);
	let magnitude = 0;
	for (const component of cut) {
		magnitude += component * component;
	}
	magnitude = Math.sqrt(magnitude);

	const out = new Float32Array(dim);
	for (let i = 0; i < dim; i++) {
		out[i] = magnitude > 0 ? cut[i] / magnitude : 0;
	}
	return out;
}
