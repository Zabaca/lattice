/**
 * Embeddings computed here, in this process.
 *
 * No daemon, no API key, no per-query network call: the weights are ONNX,
 * they are downloaded once into the Lattice home, and every command after
 * that runs against the copy on disk. What the user pays is one download and
 * a few seconds of load per command; what they get is that their notes never
 * leave the machine.
 *
 * The model itself is loaded lazily and the library is imported dynamically,
 * so a command that never embeds anything neither reads 145 MB from disk nor
 * pays for a native addon it does not use.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../utils/paths.js";
import { EmbeddingError } from "./errors.js";
import {
	documentText,
	type ModelChoice,
	type ModelSpec,
	queryText,
	resolveModelChoice,
	truncateAndRenormalize,
} from "./models.js";
import type { EmbeddingProvider } from "./provider.js";

/**
 * The weights are quantised: 8-bit is a third of the size for a retrieval
 * difference too small to measure against the cost of the download.
 */
const DTYPE = "q8";

/**
 * What a loadable model directory contains. Lattice checks for these rather
 * than asking the library, because "is it already here?" decides whether the
 * network is touched at all, and that has to be answerable offline.
 */
const REQUIRED_FILES = [
	"config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	join("onnx", `model_${DTYPE === "q8" ? "quantized" : DTYPE}.onnx`),
];

/** Where the weights are read from, and whether fetching more is permitted. */
export interface ModelSource {
	/** The model cache: one directory per hub repository underneath it. */
	cacheDir: string;
	/** False once the model is on disk — then nothing reaches the network. */
	allowRemote: boolean;
	/** Where a download would come from, when it is not the hub's own host. */
	host?: string;
}

/** A line of progress worth showing someone waiting on a download. */
export type ProgressReporter = (line: string) => void;

/**
 * Decide where this command's weights come from before loading anything.
 *
 * The rule is deliberately blunt: if the files are already there, the network
 * is not consulted at all — not for an etag, not for a revision check. That
 * is what makes a pre-placed model directory work for someone who cannot
 * download, and what makes the second run of `sync` the same offline as on.
 */
export function resolveModelSource(
	env: Record<string, string | undefined>,
	model?: ModelSpec,
): ModelSource {
	const spec = model ?? resolveModelChoice(env).model;
	const cacheDir = resolvePaths(env).models;
	const cached = isCached(cacheDir, spec);
	const offline = isOffline(env);

	if (!cached && offline) {
		throw new Error(
			`The ${spec.name} model is not in ${cacheDir} and downloading is disabled ` +
				`(LATTICE_OFFLINE / HF_HUB_OFFLINE). Place the ${spec.repo} files at ` +
				`${join(cacheDir, spec.repo)} — ${REQUIRED_FILES.join(", ")} — or allow downloading.`,
		);
	}

	const host = env.LATTICE_HF_MIRROR?.trim() || env.HF_ENDPOINT?.trim();
	return { cacheDir, allowRemote: !cached, host: host || undefined };
}

function isCached(cacheDir: string, model: ModelSpec): boolean {
	return REQUIRED_FILES.every((file) =>
		existsSync(join(cacheDir, model.repo, file)),
	);
}

/**
 * `HF_HUB_OFFLINE` is what the rest of the ecosystem sets, so it is honoured
 * beside Lattice's own variable rather than ignored.
 */
function isOffline(env: Record<string, string | undefined>): boolean {
	return [env.LATTICE_OFFLINE, env.HF_HUB_OFFLINE].some((value) => {
		const raw = value?.trim().toLowerCase();
		return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
	});
}

/** The provider `selectProvider` hands back for `LATTICE_EMBED_PROVIDER=local`. */
export function createLocalProvider(
	env: Record<string, string | undefined>,
	report?: ProgressReporter,
): EmbeddingProvider {
	const choice = resolveModelChoice(env);
	return new LocalProvider(
		choice,
		resolveModelSource(env, choice.model),
		report,
	);
}

/** What the feature-extraction pipeline is, without importing it eagerly. */
type Extractor = (
	texts: string[],
	options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

class LocalProvider implements EmbeddingProvider {
	readonly model: string;
	readonly dim: number;
	readonly source: string;
	private readonly spec: ModelSpec;
	private readonly modelSource: ModelSource;
	private readonly report?: ProgressReporter;
	private extractor?: Promise<Extractor>;

	constructor(
		choice: ModelChoice,
		modelSource: ModelSource,
		report?: ProgressReporter,
	) {
		this.spec = choice.model;
		this.model = choice.model.name;
		this.dim = choice.dim;
		this.source = choice.source;
		this.modelSource = modelSource;
		this.report = report;
	}

	embed(texts: string[]): Promise<Float32Array[]> {
		return this.run(texts.map((text) => documentText(this.spec, text)));
	}

	embedQuery(texts: string[]): Promise<Float32Array[]> {
		return this.run(texts.map((text) => queryText(this.spec, text)));
	}

	/**
	 * Get the weights onto the machine before anything needs them.
	 *
	 * Downloading is the slow part and it happens once; saying so beforehand
	 * is the difference between a wait and a hang.
	 */
	async prepare(report: ProgressReporter): Promise<void> {
		if (!this.modelSource.allowRemote) {
			report(`Model ${this.model} is already in ${this.modelSource.cacheDir}.`);
			return;
		}

		report(
			`Downloading ${this.spec.repo} into ${this.modelSource.cacheDir} (about 145 MB, once).`,
		);
		await this.pipeline();
		report(`Model ${this.model} is ready.`);
	}

	private async run(texts: string[]): Promise<Float32Array[]> {
		const extractor = await this.pipeline();
		const output = await extractor(texts, {
			pooling: this.spec.pooling,
			normalize: true,
		});

		// Truncation happens after the model has normalised its own output, and
		// re-normalises, so every vector Lattice stores has length one whatever
		// width it ended up.
		return output.tolist().map((row) => {
			// A registry entry that names the wrong native width would quietly
			// store under-width vectors in a space claiming otherwise. Caught
			// at the first passage rather than at the first query.
			if (row.length < this.dim) {
				throw new EmbeddingError(
					`${this.spec.name} emitted ${row.length} dimensions, but the index expects ${this.dim}.`,
					false,
				);
			}
			return truncateAndRenormalize(Float32Array.from(row), this.dim);
		});
	}

	/**
	 * One pipeline per provider, loaded at most once and shared by every call.
	 *
	 * How the failure is classified turns on whether this load could have gone
	 * to the network. A download is exactly the kind of thing worth another
	 * run — a timeout, a 503, a dropped connection — so it is retryable. A
	 * load from a directory already on disk is not: nothing about running the
	 * same command again makes a missing or corrupt model directory work, and
	 * calling that retryable would have every chunk record the same failure
	 * for ever.
	 */
	private pipeline(): Promise<Extractor> {
		this.extractor ??= this.build().catch((error: unknown) => {
			this.extractor = undefined;
			const message = error instanceof Error ? error.message : String(error);
			const remedy = this.modelSource.allowRemote
				? "Run the command again once the download can complete."
				: `Delete ${join(this.modelSource.cacheDir, this.spec.repo)} and run \`lattice init\` to fetch it again.`;
			throw new EmbeddingError(
				`Could not load the ${this.spec.name} model from ${this.modelSource.cacheDir}: ${message}. ${remedy}`,
				this.modelSource.allowRemote,
			);
		});
		return this.extractor;
	}

	/**
	 * A cache that holds every required file but cannot be loaded — one
	 * truncated mid-download looks exactly like this — is not something this
	 * can repair: the library's own cache lookup runs before any fetch, so
	 * the bad file wins however permissive the settings are. The failure says
	 * to delete the directory, which is the only thing that works.
	 */
	private async build(): Promise<Extractor> {
		const { env, pipeline } = await import("@huggingface/transformers");

		env.cacheDir = this.modelSource.cacheDir;
		env.allowRemoteModels = this.modelSource.allowRemote;
		if (this.modelSource.host !== undefined) {
			env.remoteHost = this.modelSource.host;
		}

		const extractor = await pipeline("feature-extraction", this.spec.repo, {
			dtype: DTYPE,
			// Only a real download is worth narrating: the library reports the
			// same events for files it found in the cache, and "fetched" lines
			// for a run that touched no network are a lie.
			progress_callback:
				this.report && this.modelSource.allowRemote
					? progressCallback(this.report)
					: undefined,
		});

		return extractor as unknown as Extractor;
	}
}

/** Percentage steps worth a line. The weights file is most of the wait. */
const PROGRESS_STEP = 10;

/**
 * Turn the library's file-by-file events into something a person reads.
 *
 * A tenth at a time, and a line when a file lands: enough that a 145 MB
 * download visibly moves, without a line per chunk that scrolls the reason
 * for the wait off the screen.
 */
function progressCallback(report: ProgressReporter) {
	const reported = new Map<string, number>();

	return (event: unknown) => {
		const { status, file, progress } = event as {
			status?: string;
			file?: string;
			progress?: number;
		};
		if (file === undefined) {
			return;
		}

		if (status === "progress" && typeof progress === "number") {
			const step = Math.floor(progress / PROGRESS_STEP) * PROGRESS_STEP;
			if (step > 0 && step < 100 && (reported.get(file) ?? 0) < step) {
				reported.set(file, step);
				report(`  ${file} ${step}%`);
			}
			return;
		}

		if (status === "done") {
			report(`  fetched ${file}`);
		}
	};
}
