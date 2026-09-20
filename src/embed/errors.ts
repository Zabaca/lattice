/**
 * A failure the provider chose to classify.
 *
 * `retryable` is the whole point: a timeout is worth another run, a text the
 * model will never accept is not, and the embed phase treats them differently.
 *
 * This lives on its own so a provider implementation can throw it without
 * importing the module that selects providers.
 */
export class EmbeddingError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "EmbeddingError";
		this.retryable = retryable;
	}
}
