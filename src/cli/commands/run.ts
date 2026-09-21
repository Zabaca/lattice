import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { checkActiveSpace } from "../../embed/state.js";
import { selectTextProvider, type TextProvider } from "../../llm/provider.js";
import { RerankConfigurationError } from "../../rerank/provider.js";
import { type Candidate, type Judge, selectJudge } from "../../run/judge.js";
import {
	DEFAULT_MAX_REWRITES,
	type RunnerDeps,
	type RunResult,
	runLoop,
} from "../../run/runner.js";
import { embedQuery } from "../../search/embed-query.js";
import { search } from "../../search/search.js";
import { resolvePaths } from "../../utils/paths.js";
import { selectWebSearcher, type WebSearcher } from "../../web/provider.js";
import { count, text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";

/** Concepts one query pulls from the index. */
const INDEX_LIMIT = 5;
/** Passages read per concept. */
const CHUNKS_PER_CONCEPT = 2;
/** Pages one query pulls from the web. */
const WEB_LIMIT = 5;

/**
 * Run the judged search loop over the index and the web, or over either
 * alone (`--no-web`, `--no-index`). The index must exist even for a web-only
 * run: the command is a view over one Lattice home.
 *
 * The loop is `src/run/runner.ts`; this reads the flags, builds the three
 * providers, wires the index and web searches to it, and renders where it
 * stopped and what it kept.
 */
export async function runRun(context: CommandContext): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);
	const noIndex = context.flags["no-index"] !== undefined;
	if (noIndex && context.flags["no-web"] !== undefined) {
		return {
			code: 1,
			stderr: "--no-index and --no-web together leave nothing to search.",
		};
	}
	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	let maxRewrites: number;
	let llm: TextProvider;
	let judge: Judge;
	let web: WebSearcher | undefined;
	try {
		maxRewrites =
			context.flags["max-rewrites"] === "0"
				? 0
				: count(
						context.flags["max-rewrites"],
						DEFAULT_MAX_REWRITES,
						"--max-rewrites",
					);
		llm = selectTextProvider(context.env);
		judge = selectJudge(context.env);
	} catch (error) {
		return { code: 1, stderr: (error as Error).message };
	}
	// A web searcher that cannot be built is a reason, not a refusal: the run
	// goes on over the index, as `search` does without its semantic leg.
	let webReason: string | undefined;
	if (context.flags["no-web"] === undefined) {
		try {
			web = selectWebSearcher(context.env);
		} catch (error) {
			webReason = (error as Error).message;
		}
	}

	const question = context.positionals[0];
	const tried = text(context.flags.tried)
		?.split(",")
		.map((query) => query.trim())
		.filter((query) => query !== "");

	const db = openDatabase(paths.database);
	try {
		const passageText = db.prepare<{ content: string }, [string, number]>(
			`SELECT ch.content FROM chunks ch
			 JOIN concepts c ON c.id = ch.concept_id
			 WHERE c.path = ? AND ch.ordinal = ?`,
		);
		const deps: RunnerDeps = {
			searchIndex: noIndex
				? undefined
				: async (query) => {
						const embedded = await embedQuery(
							query,
							context.env,
							context.report,
						);
						if (embedded.space !== undefined) {
							const mismatch = checkActiveSpace(
								db,
								embedded.space,
								embedded.source ?? "",
							);
							if (mismatch !== undefined) {
								throw new Error(mismatch);
							}
						}
						const result = await search(db, {
							query,
							limit: INDEX_LIMIT,
							chunksPerConcept: CHUNKS_PER_CONCEPT,
							asOf: Date.now(),
							expand: 0,
							candidates: INDEX_LIMIT,
							semantic: embedded.semantic,
							semanticUnavailable: embedded.reason,
						});
						// The judge and the skill read the passage itself, not the
						// 180-character window `search` shows: a snippet cut mid-sentence
						// reads as a gap that the document does not have.
						return result.hits.map(
							(hit): Candidate => ({
								source: "index",
								title: hit.title ?? hit.path,
								ref: hit.path,
								text: hit.chunks
									.map(
										(chunk) =>
											passageText.get(hit.path, chunk.ordinal)?.content ??
											chunk.snippet,
									)
									.join("\n\n"),
							}),
						);
					},
			searchWeb:
				web === undefined
					? undefined
					: async (query) => {
							const response = await web.search({
								query,
								type: "fast",
								limit: WEB_LIMIT,
								text: false,
							});
							return {
								candidates: response.results.map(
									(page): Candidate => ({
										source: "web",
										title: page.title ?? page.url,
										ref: page.url,
										text: page.highlights.join("\n"),
									}),
								),
								costUsd: response.cost,
							};
						},
			judge,
			llm,
		};

		let result: RunResult;
		try {
			result = await runLoop(deps, { question, tried, maxRewrites });
		} catch (error) {
			if (error instanceof RerankConfigurationError) {
				return { code: 1, stderr: error.message };
			}
			throw error;
		}
		if (webReason !== undefined && result.webReason === null) {
			result.webReason = webReason;
		}

		if (context.flags.json !== undefined) {
			return { code: 0, stdout: `${JSON.stringify(result)}\n` };
		}
		return { code: 0, stdout: render(result) };
	} finally {
		db.close();
	}
}

function render(result: RunResult): string {
	const lines = [
		`${result.exit}  completeness ${result.completeness.toFixed(2)} (${result.completenessLabel})` +
			`  after ${result.tried.length} queries, ${result.records.length} judgements`,
	];
	if (result.exit === "decide") {
		const last = result.records[result.records.length - 1];
		lines.push(
			`   judge unsure: ${Object.entries(last.probabilities)
				.map(([name, p]) => `${name} ${p.toFixed(2)}`)
				.join(", ")}`,
		);
	}
	lines.push("");
	if (result.kept.length === 0) {
		lines.push("Nothing kept.");
	}
	result.kept.forEach((candidate, index) => {
		lines.push(
			`${index + 1}. [${candidate.source}] ${candidate.title} — ${candidate.ref}`,
		);
	});
	lines.push("");
	lines.push(
		`cost: llm $${result.cost.llmUsd.toFixed(4)} over ${result.cost.llmCalls} calls, ` +
			`jev ${result.cost.jevInputTokens} input tokens, web $${result.cost.webUsd.toFixed(4)}`,
	);
	if (result.webReason !== null) {
		lines.push(`web: ${result.webReason}`);
	}
	return `${lines.join("\n")}\n`;
}
