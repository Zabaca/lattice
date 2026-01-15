import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { GraphService } from "../graph/graph.service.js";
import { getDocsPath } from "../utils/paths.js";

interface TopicInfo {
	slug: string;
	title: string;
	summary: string;
	domain: string;
}

@Injectable()
export class WelcomeGeneratorService {
	private readonly logger = new Logger(WelcomeGeneratorService.name);

	// Acronyms to preserve in uppercase
	private readonly acronyms = new Set([
		"ai",
		"ml",
		"api",
		"llm",
		"gpu",
		"ui",
		"ux",
		"ci",
		"cd",
		"aws",
		"gcp",
		"seo",
		"css",
		"html",
		"sql",
		"cli",
		"sdk",
		"mcp",
	]);

	constructor(private readonly graphService: GraphService) {}

	/**
	 * Generate welcome.md from DuckDB topic data
	 */
	async generate(): Promise<string> {
		const topics = await this.fetchTopics();
		const grouped = this.groupByDomain(topics);
		const markdown = this.generateMarkdown(grouped, topics.length);

		const docsPath = getDocsPath();
		const welcomePath = path.join(docsPath, "welcome.md");
		writeFileSync(welcomePath, markdown, "utf-8");

		this.logger.log(`Generated welcome.md with ${topics.length} topics`);
		return welcomePath;
	}

	/**
	 * Fetch topic metadata from DuckDB
	 */
	private async fetchTopics(): Promise<TopicInfo[]> {
		const sql = `
			SELECT
				name,
				properties->>'title' as title,
				properties->>'summary' as summary,
				properties->>'domain' as domain
			FROM nodes
			WHERE label = 'Document' AND name LIKE '%/README.md'
			ORDER BY name
		`;

		const result = await this.graphService.query(sql);
		const topics: TopicInfo[] = [];

		for (const row of result.resultSet) {
			const [filePath, title, summary, domain] = row as [
				string,
				string | null,
				string | null,
				string | null,
			];

			// Extract topic slug from path
			// /Users/uptown/.lattice/docs/agents/README.md -> agents
			const slug = this.extractSlug(filePath);
			if (!slug) {
				this.logger.warn(`Could not extract slug from ${filePath}`);
				continue;
			}

			topics.push({
				slug,
				title: title || this.formatSlugAsTitle(slug),
				summary: summary || "",
				domain: domain || "uncategorized",
			});
		}

		return topics.sort((a, b) => a.slug.localeCompare(b.slug));
	}

	/**
	 * Extract topic slug from file path
	 */
	private extractSlug(filePath: string): string | null {
		// Match /docs/TOPIC_NAME/README.md
		const match = filePath.match(/\/docs\/([^/]+)\/README\.md$/i);
		return match ? match[1] : null;
	}

	/**
	 * Convert slug to title case if no title available
	 */
	private formatSlugAsTitle(slug: string): string {
		return slug
			.split("-")
			.map((word) => {
				const lower = word.toLowerCase();
				if (this.acronyms.has(lower)) {
					return word.toUpperCase();
				}
				return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
			})
			.join(" ");
	}

	/**
	 * Group topics by domain
	 */
	private groupByDomain(topics: TopicInfo[]): Map<string, TopicInfo[]> {
		const grouped = new Map<string, TopicInfo[]>();

		for (const topic of topics) {
			const domain = topic.domain;
			if (!grouped.has(domain)) {
				grouped.set(domain, []);
			}
			grouped.get(domain)?.push(topic);
		}

		return grouped;
	}

	/**
	 * Convert kebab-case domain to Title Case
	 */
	private formatDomain(domain: string): string {
		if (domain === "uncategorized") {
			return "Uncategorized";
		}

		return domain
			.split("-")
			.map((word) => {
				const lower = word.toLowerCase();
				if (this.acronyms.has(lower)) {
					return word.toUpperCase();
				}
				return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
			})
			.join(" ");
	}

	/**
	 * Generate markdown content
	 */
	private generateMarkdown(
		grouped: Map<string, TopicInfo[]>,
		totalTopics: number,
	): string {
		const currentDate = new Date().toISOString().split("T")[0];

		const lines: string[] = [
			"---",
			`created: ${currentDate}`,
			`updated: ${currentDate}`,
			"status: ongoing",
			"topic: welcome",
			'summary: "Auto-generated index of all research topics organized by domain."',
			"---",
			"",
			"# Research Directory",
			"",
			`Organized collection of ${totalTopics} research topics. This page is auto-generated from the knowledge graph.`,
			"",
		];

		// Sort domains alphabetically, but put Uncategorized last
		const sortedDomains = Array.from(grouped.keys()).sort((a, b) => {
			if (a === "uncategorized") return 1;
			if (b === "uncategorized") return -1;
			return this.formatDomain(a).localeCompare(this.formatDomain(b));
		});

		for (const domain of sortedDomains) {
			const topics = grouped.get(domain);
			if (!topics) continue;
			const displayDomain = this.formatDomain(domain);

			lines.push(`## ${displayDomain}`);
			lines.push("");
			lines.push("| Topic | Description |");
			lines.push("|-------|-------------|");

			for (const topic of topics) {
				// Link format: ./topic/readme (matches Astro routes)
				const link = `./${topic.slug}/readme`;
				const summary = this.truncateSummary(topic.summary, 100);
				// Escape pipe characters in summary for table
				const escapedSummary = summary.replace(/\|/g, "\\|");
				lines.push(`| [${topic.slug}](${link}) | ${escapedSummary} |`);
			}

			lines.push("");
		}

		lines.push("---");
		lines.push(`*Auto-generated: ${currentDate}*`);
		lines.push("");

		return lines.join("\n");
	}

	/**
	 * Truncate summary to max length
	 */
	private truncateSummary(summary: string, maxLength: number): string {
		// Clean up multiline summaries
		const cleaned = summary.replace(/\s+/g, " ").trim();
		if (cleaned.length <= maxLength) {
			return cleaned;
		}
		return `${cleaned.slice(0, maxLength - 3)}...`;
	}
}
