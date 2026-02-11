/**
 * Exa API types for the research module
 */

export interface ExaSearchOptions {
	query: string;
	numResults?: number;
	type?: "auto" | "keyword" | "neural";
	includeDomains?: string[];
	excludeDomains?: string[];
	startPublishedDate?: string;
	endPublishedDate?: string;
	category?: string;
	contents?: {
		text?: boolean;
		highlights?: boolean;
		summary?: boolean;
	};
}

export interface ExaSearchResult {
	title: string;
	url: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
	highlights?: string[];
	summary?: string;
}

export interface ExaSearchResponse {
	requestId: string;
	results: ExaSearchResult[];
	autopromptString?: string;
}
