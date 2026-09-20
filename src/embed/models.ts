/**
 * The models Lattice knows how to run.
 *
 * A vector only means something beside another vector from the same model, so
 * the registry is what makes "which model is this index in?" a question with
 * an answer. Each entry carries everything the provider needs and nothing it
 * does not: where the weights come from, how the token vectors are pooled,
 * the prefixes the model was trained to expect, and what dimensions are
 * legitimate for it.
 */

/** How a model's token vectors become one vector for the passage. */
export type Pooling = "mean" | "cls";

export interface ModelSpec {
	/** The canonical, already-normalised name. This is what the index records. */
	readonly name: string;
	/** The hub repository the weights are downloaded from. */
	readonly repo: string;
	readonly pooling: Pooling;
	/** Prepended to a passage being indexed. Empty when the model wants none. */
	readonly documentPrefix: string;
	/** Prepended to a search query. Empty when the model wants none. */
	readonly queryPrefix: string;
	/** What the model actually emits. */
	readonly nativeDim: number;
	/** What Lattice stores by default. */
	readonly defaultDim: number;
	/**
	 * Whether the model was trained so that a truncated vector is still a
	 * usable vector (Matryoshka representation learning). Truncating one that
	 * was not is silent corruption, so it is refused.
	 */
	readonly truncatable: boolean;
	/** Tokens the model can attend to; longer text is truncated by the tokenizer. */
	readonly contextTokens: number;
}

/**
 * The default is chosen on measured cost: 145 MB quantised, ~5 s to cold-load,
 * and truncatable to 512 dimensions, which halves storage against its native
 * 768 for a loss it was trained to absorb. The larger model is there for
 * anyone who would rather pay for the quality.
 */
export const DEFAULT_MODEL = "nomic-embed-text-v1.5";

const MODELS: readonly ModelSpec[] = [
	{
		name: "nomic-embed-text-v1.5",
		repo: "nomic-ai/nomic-embed-text-v1.5",
		pooling: "mean",
		documentPrefix: "search_document: ",
		queryPrefix: "search_query: ",
		nativeDim: 768,
		defaultDim: 512,
		truncatable: true,
		contextTokens: 8192,
	},
	{
		name: "bge-small-en-v1.5",
		repo: "Xenova/bge-small-en-v1.5",
		pooling: "cls",
		documentPrefix: "",
		queryPrefix: "Represent this sentence for searching relevant passages: ",
		nativeDim: 384,
		defaultDim: 384,
		truncatable: false,
		contextTokens: 512,
	},
	{
		name: "mxbai-embed-large-v1",
		repo: "mixedbread-ai/mxbai-embed-large-v1",
		pooling: "cls",
		documentPrefix: "",
		queryPrefix: "Represent this sentence for searching relevant passages: ",
		nativeDim: 1024,
		defaultDim: 1024,
		truncatable: false,
		contextTokens: 512,
	},
];

/**
 * The one spelling of a model name that gets compared and stored.
 *
 * Users write a model name the way their last tool spelled it — with the
 * organisation, with a registry host, with a tag. None of those change which
 * weights run, so none of them may look like a model change.
 */
export function canonicalModelName(name: string): string {
	let value = name.trim().toLowerCase();
	value = value.replace(/^[a-z]+:\/\//, "");
	value = value.replace(/^(hf\.co|huggingface\.co)\//, "");

	const segments = value.split("/").filter((segment) => segment !== "");
	value = segments[segments.length - 1] ?? "";

	const tag = value.lastIndexOf(":");
	if (tag !== -1) {
		value = value.slice(0, tag);
	}

	return value;
}

/** The registered model with this name, or undefined. */
export function findModel(name: string): ModelSpec | undefined {
	const normalized = canonicalModelName(name);
	return MODELS.find((model) => model.name === normalized);
}

/** Every registered model name, for an error message that helps. */
export function modelNames(): string[] {
	return MODELS.map((model) => model.name);
}

/**
 * Which model this command should use, at which width, and where that came
 * from.
 *
 * `source` is carried because the message a user sees when their index and
 * their configuration disagree is only actionable if it says which of the two
 * they changed.
 */
export interface ModelChoice {
	readonly model: ModelSpec;
	readonly dim: number;
	/** Human-readable provenance: an environment variable, or the default. */
	readonly source: string;
}

export function resolveModelChoice(
	env: Record<string, string | undefined>,
): ModelChoice {
	const requested = env.LATTICE_EMBED_MODEL?.trim();
	const name = requested || DEFAULT_MODEL;
	const source = describeSource([
		requested ? "LATTICE_EMBED_MODEL" : undefined,
		env.LATTICE_EMBED_DIM?.trim() ? "LATTICE_EMBED_DIM" : undefined,
	]);

	const model = findModel(name);
	if (model === undefined) {
		throw new Error(
			`Unknown embedding model: ${name} (from ${source}). ` +
				`Known models: ${modelNames().join(", ")}.`,
		);
	}

	return { model, dim: resolveDim(env, model), source };
}

/**
 * Name every variable the user actually set.
 *
 * Both halves of a space can be configured separately, and the one they
 * changed is the one they need pointed at — telling someone who moved the
 * width that the model came from "the built-in default" is worse than saying
 * nothing.
 */
function describeSource(variables: Array<string | undefined>): string {
	const set = variables.filter((name): name is string => name !== undefined);
	if (set.length === 0) {
		return "the built-in default";
	}
	return set.join(" and ");
}

/**
 * The width to store, which is the model's default unless the user asked for
 * less and the model was trained to survive it.
 */
function resolveDim(
	env: Record<string, string | undefined>,
	model: ModelSpec,
): number {
	const raw = env.LATTICE_EMBED_DIM?.trim();
	if (!raw) {
		return model.defaultDim;
	}

	const dim = Number.parseInt(raw, 10);
	if (!Number.isInteger(dim) || dim <= 0) {
		throw new Error(`LATTICE_EMBED_DIM must be a positive integer, got ${raw}`);
	}
	if (dim > model.nativeDim) {
		throw new Error(
			`LATTICE_EMBED_DIM is ${dim}, but ${model.name} emits ${model.nativeDim} dimensions.`,
		);
	}
	if (dim < model.nativeDim && !model.truncatable) {
		throw new Error(
			`${model.name} was not trained for truncated vectors, so it cannot emit ${dim} ` +
				`of its ${model.nativeDim} dimensions. Use ${model.nativeDim}, or a model that supports it.`,
		);
	}

	return dim;
}

/**
 * A passage as the model wants to be handed it.
 *
 * Asymmetric models are trained with these prefixes, and dropping them costs
 * real retrieval quality — the query and the passage stop landing in the same
 * neighbourhood — so they are the provider's job, not the caller's.
 */
export function documentText(model: ModelSpec, text: string): string {
	return `${model.documentPrefix}${text}`;
}

/** A question as the model wants to be handed it. */
export function queryText(model: ModelSpec, text: string): string {
	return `${model.queryPrefix}${text}`;
}

/**
 * Cut a vector down to `dim` and make it a unit vector again.
 *
 * Renormalising is not cosmetic: truncation shortens the vector, and a dot
 * product only reads as a cosine similarity while both sides have length one.
 */
export function truncateAndRenormalize(
	vector: Float32Array,
	dim: number,
): Float32Array {
	if (dim >= vector.length) {
		return vector;
	}

	const cut = vector.slice(0, dim);
	let magnitude = 0;
	for (const component of cut) {
		magnitude += component * component;
	}
	magnitude = Math.sqrt(magnitude);
	if (magnitude > 0) {
		for (let i = 0; i < cut.length; i++) {
			cut[i] /= magnitude;
		}
	}

	return cut;
}
