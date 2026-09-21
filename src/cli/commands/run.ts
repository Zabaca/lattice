import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import { selectTextProvider, type TextProvider } from "../../llm/provider.js";
import { RerankConfigurationError } from "../../rerank/provider.js";
import { type Judge, selectJudge } from "../../run/judge.js";
import {
	DEFAULT_MAX_REWRITES,
	type RunResult,
	runLoop,
} from "../../run/runner.js";
import { resolvePaths } from "../../utils/paths.js";
import {
	selectWebSearcher,
	WebConfigurationError,
	type WebSearcher,
} from "../../web/provider.js";
import { count, text } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";
import {
	DEFAULT_WEB_ESCALATION,
	DEFAULT_WEB_LEGS,
	memoised,
	searchDeps,
	webReasons,
} from "./run-deps.js";

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
	// goes on over the index, as `search` does without its semantic leg. A
	// name that is not a searcher is a refusal.
	let webReason: string | undefined;
	if (context.flags["no-web"] === undefined) {
		try {
			web = selectWebSearcher(context.env, DEFAULT_WEB_LEGS, {
				defaultEscalation: DEFAULT_WEB_ESCALATION,
			});
		} catch (error) {
			if (error instanceof WebConfigurationError) {
				return { code: 1, stderr: error.message };
			}
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
		const deps = {
			...searchDeps({
				db,
				provider: memoised(() => selectProvider(context.env, context.report)),
				web,
				index: !noIndex,
			}),
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
		result.webReason = webReasons(result, webReason, web);

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
		const source =
			candidate.read === true ? `${candidate.source}, read` : candidate.source;
		lines.push(
			`${index + 1}. [${source}] ${candidate.title} — ${candidate.ref}`,
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
