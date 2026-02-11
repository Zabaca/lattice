import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExaSearchResponseSchema } from "../schemas/exa.schemas.js";
import type {
	ExaSearchOptions,
	ExaSearchResponse,
	ExaSearchResult,
} from "./exa.types.js";

@Injectable()
export class ExaSearchService {
	private readonly logger = new Logger(ExaSearchService.name);
	private readonly baseUrl = "https://api.exa.ai";
	private apiKey: string | undefined;

	constructor(private configService: ConfigService) {
		// Lazy — only resolve key when needed
		this.apiKey = this.configService.get<string>("EXA_API_KEY");
	}

	/**
	 * Check whether the Exa API is configured (key present).
	 */
	isConfigured(): boolean {
		return !!this.apiKey;
	}

	/**
	 * Perform a search query against the Exa API.
	 */
	async search(options: ExaSearchOptions): Promise<ExaSearchResponse> {
		if (!this.apiKey) {
			throw new Error(
				"EXA_API_KEY is not configured. Add it to ~/.lattice/.env to enable web research.",
			);
		}

		const body: Record<string, unknown> = {
			query: options.query,
			numResults: options.numResults ?? 10,
			type: options.type ?? "auto",
		};

		if (options.includeDomains?.length) {
			body.includeDomains = options.includeDomains;
		}
		if (options.excludeDomains?.length) {
			body.excludeDomains = options.excludeDomains;
		}
		if (options.startPublishedDate) {
			body.startPublishedDate = options.startPublishedDate;
		}
		if (options.endPublishedDate) {
			body.endPublishedDate = options.endPublishedDate;
		}
		if (options.category) {
			body.category = options.category;
		}

		// Default to highlights + summary
		const contents = options.contents ?? { highlights: true, summary: true };
		body.contents = contents;

		this.logger.debug(`Exa search: "${options.query}"`);

		const response = await fetch(`${this.baseUrl}/search`, {
			method: "POST",
			headers: {
				"x-api-key": this.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				`Exa API error: ${response.status} ${JSON.stringify(error)}`,
			);
		}

		const data = ExaSearchResponseSchema.parse(await response.json());

		return {
			requestId: data.requestId ?? "",
			results: data.results.map(
				(r): ExaSearchResult => ({
					title: r.title,
					url: r.url,
					publishedDate: r.publishedDate ?? undefined,
					author: r.author ?? undefined,
					score: r.score,
					text: r.text ?? undefined,
					highlights: r.highlights ?? undefined,
					summary: r.summary ?? undefined,
				}),
			),
			autopromptString: data.autopromptString,
		};
	}

	/**
	 * Find content similar to a given URL.
	 */
	async findSimilar(url: string, numResults = 10): Promise<ExaSearchResponse> {
		if (!this.apiKey) {
			throw new Error(
				"EXA_API_KEY is not configured. Add it to ~/.lattice/.env to enable web research.",
			);
		}

		const response = await fetch(`${this.baseUrl}/findSimilar`, {
			method: "POST",
			headers: {
				"x-api-key": this.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url,
				numResults,
				contents: { highlights: true, summary: true },
			}),
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				`Exa API error: ${response.status} ${JSON.stringify(error)}`,
			);
		}

		const data = ExaSearchResponseSchema.parse(await response.json());

		return {
			requestId: data.requestId ?? "",
			results: data.results.map(
				(r): ExaSearchResult => ({
					title: r.title,
					url: r.url,
					publishedDate: r.publishedDate ?? undefined,
					author: r.author ?? undefined,
					score: r.score,
					text: r.text ?? undefined,
					highlights: r.highlights ?? undefined,
					summary: r.summary ?? undefined,
				}),
			),
			autopromptString: data.autopromptString,
		};
	}
}
