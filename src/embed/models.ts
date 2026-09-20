/**
 * The models Lattice knows how to embed with.
 *
 * A model is not just a file: it pools its token vectors one particular way,
 * it may demand a prefix that tells it whether it is reading a query or a
 * document, and only some of them were trained so that a prefix of the vector
 * is itself a usable vector. Getting any of that wrong produces embeddings
 * that look fine and retrieve badly, so it is written down here once rather
 * than guessed at the call site.
 *
 * The default was chosen on measured cost. On an M-series laptop, q8 ONNX
 * through transformers.js:
 *
 *   all-MiniLM-L6-v2       24 MB   10.0 s first load    40 ms / 64 chunks
 *   bge-base-en-v1.5      113 MB   43.8 s first load   131 ms / 64 chunks
 *   nomic-embed-text-v1.5 145 MB   52.8 s first load   187 ms / 64 chunks
 *
 * The cheapest is the default; the other two stay selectable, and are worth
 * their cost for a bundle whose passages run past MiniLM's 256-token ceiling.
 */

export interface ModelEntry {
	/** The canonical, already-normalised name. */
	readonly name: string;
	/** Where the ONNX weights come from. */
	readonly repo: string;
	/** ONNX weight precision to request. */
	readonly dtype: "fp32" | "q8";
	/** How token vectors become one vector. */
	readonly pooling: "mean" | "cls";
	/** What the model wants in front of a search query. */
	readonly queryPrefix: string;
	/** What it wants in front of an indexed passage. */
	readonly documentPrefix: string;
	/** The dimension the model actually emits. */
	readonly nativeDim: number;
	/** The dimension Lattice stores. Below `nativeDim` only for matryoshka models. */
	readonly dim: number;
	/**
	 * Trained so that the first N components are a usable vector on their own.
	 * Truncating anything else silently destroys the embedding.
	 */
	readonly matryoshka: boolean;
	/** Tokens the model reads before it starts discarding text. */
	readonly contextTokens: number;
}

const ENTRIES: ModelEntry[] = [
	{
		name: "all-minilm-l6-v2",
		repo: "Xenova/all-MiniLM-L6-v2",
		dtype: "q8",
		pooling: "mean",
		queryPrefix: "",
		documentPrefix: "",
		nativeDim: 384,
		dim: 384,
		matryoshka: false,
		contextTokens: 256,
	},
	{
		name: "bge-base-en-v1.5",
		repo: "Xenova/bge-base-en-v1.5",
		dtype: "q8",
		pooling: "cls",
		// BGE asks for an instruction on the query side only; prefixing the
		// documents as well measurably hurts it.
		queryPrefix: "Represent this sentence for searching relevant passages: ",
		documentPrefix: "",
		nativeDim: 768,
		dim: 768,
		matryoshka: false,
		contextTokens: 512,
	},
	{
		name: "nomic-embed-text-v1.5",
		repo: "nomic-ai/nomic-embed-text-v1.5",
		dtype: "q8",
		pooling: "mean",
		queryPrefix: "search_query: ",
		documentPrefix: "search_document: ",
		nativeDim: 768,
		// Trained with Matryoshka representation learning, so 512 of its 768
		// components carry nearly all of the quality at two-thirds the storage.
		dim: 512,
		matryoshka: true,
		contextTokens: 8192,
	},
];

export const MODELS: ReadonlyMap<string, ModelEntry> = new Map(
	ENTRIES.map((entry) => [entry.name, entry]),
);

export const DEFAULT_MODEL = "all-minilm-l6-v2";

/**
 * One written form of a model name reduced to the one Lattice compares.
 *
 * `Xenova/all-MiniLM-L6-v2`, `all-minilm-l6-v2` and a stray-whitespace version
 * of either all name the same model, and a cosmetic difference must never be
 * mistaken for a model change.
 */
export function canonicalModelName(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * The identity recorded with every vector: the model AND the dimension, so
 * storing a truncated vector can never be confused with storing a full one.
 */
export function modelIdentity(entry: ModelEntry): string {
	return `${entry.name}-${entry.dim}`;
}

export interface ModelChoice {
	entry: ModelEntry;
	/** Where the choice came from, for a model-change message. */
	source: string;
}

/** The model this environment asks for, or the default. */
export function resolveModel(
	env: Record<string, string | undefined>,
): ModelChoice {
	const requested = env.LATTICE_EMBED_MODEL?.trim();
	if (!requested) {
		return { entry: requireEntry(DEFAULT_MODEL), source: "the default" };
	}

	const name = canonicalModelName(requested);
	const entry = MODELS.get(name);
	if (entry === undefined) {
		throw new Error(
			`Unknown embedding model: ${requested}. Known models: ${[...MODELS.keys()].join(", ")}.`,
		);
	}
	return { entry, source: "LATTICE_EMBED_MODEL" };
}

function requireEntry(name: string): ModelEntry {
	const entry = MODELS.get(name);
	if (entry === undefined) {
		throw new Error(`The default model ${name} is not in the registry.`);
	}
	return entry;
}
