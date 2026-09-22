import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDatabase } from "../../db/open.js";
import {
	type EmbeddingProvider,
	selectProvider,
} from "../../embed/provider.js";
import { selectTextProvider, type TextProvider } from "../../llm/provider.js";
import { RerankConfigurationError } from "../../rerank/provider.js";
import { type HubCandidate, type Judge, selectJudge } from "../../run/judge.js";
import {
	type ResearchDeps,
	type ResearchResult,
	researchLoop,
} from "../../run/research.js";
import { DEFAULT_MAX_REWRITES } from "../../run/runner.js";
import { embedQueryWith } from "../../search/embed-query.js";
import { searchConcepts } from "../../search/search.js";
import { LockHeldError } from "../../sync/lock.js";
import { resolvePaths } from "../../utils/paths.js";
import {
	selectWebSearcher,
	WebConfigurationError,
	type WebSearcher,
} from "../../web/provider.js";
import { selectWriter, type Writer } from "../../write/provider.js";
import { count } from "../flags.js";
import type { CommandContext, CommandOutput } from "../run.js";
import { findConcept, relationsFor } from "./rels.js";
import {
	DEFAULT_WEB_ESCALATION,
	DEFAULT_WEB_LEGS,
	searchDeps,
	webReasons,
} from "./run-deps.js";
import { SpaceMismatchError, syncBundle } from "./sync.js";

/** Hubs shortlisted for the judge to place the topic under; the bundle's hubs grow, a request should not. */
const HUB_SHORTLIST = 10;

/**
 * Research a topic end to end: the judged loop over the index, a decision
 * from what it kept, the judged loop over the web, one writer call, the
 * document filed and linked, the bundle synced, the relations read back.
 *
 * The machine is `src/run/research.ts`; this reads the flags, builds the
 * providers — the same three `run` builds, plus the writer and the
 * embedding provider the sync will need — wires the disk to it, and
 * renders what it decided and did. Exit 0 is the loop finishing, whatever
 * it decided; exit 1 is a document the writer could not get right, or a
 * configuration the command could not run under.
 */
export async function runResearch(
	context: CommandContext,
): Promise<CommandOutput> {
	const paths = resolvePaths(context.env);
	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	let maxRewrites: number;
	let llm: TextProvider;
	let judge: Judge;
	let writer: Writer;
	let provider: EmbeddingProvider;
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
		writer = selectWriter(context.env);
		// Built once, before anything runs: the sync at the end needs it, and
		// a mistyped provider should fail here rather than after the writer
		// has been paid.
		provider = selectProvider(context.env, context.report);
	} catch (error) {
		return { code: 1, stderr: (error as Error).message };
	}
	// A web searcher that cannot be built is a reason, not a refusal: the
	// index run still says whether there is anything to research. A name
	// that is not a searcher is a refusal.
	let webReason: string | undefined;
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

	const topic = context.positionals[0];
	// The search connection is closed before the sync takes the lock and
	// opens its own; `close` is idempotent so the `finally` below is safe.
	let db: ReturnType<typeof openDatabase> | undefined = openDatabase(
		paths.database,
	);
	const close = (): void => {
		db?.close();
		db = undefined;
	};
	try {
		const legs = searchDeps({ db, provider: () => provider, web, index: true });
		if (legs.searchIndex === undefined) {
			throw new Error("the index leg was not built");
		}
		const hubText = db.prepare<
			{ title: string | null; description: string | null },
			[string]
		>("SELECT title, description FROM concepts WHERE path = ?");
		const deps: ResearchDeps = {
			searchIndex: legs.searchIndex,
			listHubs: async (question) => {
				if (db === undefined) {
					throw new Error("the index connection is closed");
				}
				const embedded = await embedQueryWith(question, () => provider);
				const result = await searchConcepts(db, {
					query: question,
					limit: HUB_SHORTLIST,
					chunksPerConcept: 1,
					asOf: Date.now(),
					expand: 0,
					candidates: HUB_SHORTLIST,
					semantic: embedded.semantic,
					semanticUnavailable: embedded.reason,
					type: "Topic",
				});
				return result.hits.map((hit): HubCandidate => {
					const row = hubText.get(hit.path);
					return {
						path: hit.path,
						title: row?.title ?? hit.title ?? hit.path,
						description: row?.description ?? "",
					};
				});
			},
			searchWeb: legs.searchWeb,
			readPage: legs.readPage,
			judge,
			llm,
			writer,
			bundle: {
				read: (path) => {
					const file = join(paths.docs, path);
					return existsSync(file) ? readFileSync(file, "utf8") : undefined;
				},
				write: (path, text) => {
					const file = join(paths.docs, path);
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(file, text, "utf8");
				},
				exists: (path) => existsSync(join(paths.docs, path)),
			},
			sync: async () => {
				close();
				return (await syncBundle(paths, provider)).report;
			},
			relations: (path) => {
				const fresh = openDatabase(paths.database);
				try {
					const concept = findConcept(fresh, path);
					if (concept === undefined) {
						return undefined;
					}
					const relations = relationsFor(fresh, concept.id);
					return {
						outlinks: relations.outlinks.map((edge) => edge.path),
						backlinks: relations.backlinks.map((edge) => edge.path),
						unresolved: relations.unresolved.map((link) => link.target_path),
					};
				} finally {
					fresh.close();
				}
			},
		};

		let result: ResearchResult;
		try {
			result = await researchLoop(deps, { topic, maxRewrites, webReason });
		} catch (error) {
			if (
				error instanceof RerankConfigurationError ||
				error instanceof LockHeldError ||
				error instanceof SpaceMismatchError
			) {
				return { code: 1, stderr: error.message };
			}
			throw error;
		}
		result.webReason = webReasons(result, webReason, web);

		const code = result.draft === undefined ? 0 : 1;
		if (context.flags.json !== undefined) {
			return {
				code,
				stdout: `${JSON.stringify(result)}\n`,
				...(code === 0 ? {} : { stderr: `${result.reason}\n` }),
			};
		}
		return {
			code,
			stdout: render(result),
			...(code === 0 ? {} : { stderr: `${result.reason}\n` }),
		};
	} finally {
		close();
	}
}

function render(result: ResearchResult): string {
	const lines: string[] = [];
	// The answer first: the report of how it was found is worth less than
	// what was found.
	if (result.document !== null) {
		lines.push(
			result.document.description,
			"",
			result.document.keyFindings,
			"",
		);
	}
	const loop = (
		name: string,
		run: NonNullable<ResearchResult["web"]> | ResearchResult["index"],
	): string =>
		`${name}: ${run.exit}, completeness ${run.completeness.toFixed(2)} (${run.completenessLabel})` +
		` after ${run.tried.length} queries, ${run.kept.length} kept`;
	lines.push(loop("index", result.index));
	lines.push(`decision: ${result.decision}`);
	if (result.web !== null) {
		lines.push(loop("web", result.web));
	}
	if (result.document === null) {
		lines.push(`nothing written: ${result.reason}`);
	} else {
		const doc = result.document;
		lines.push(`${doc.action}: ${doc.path} — ${doc.title}`);
		lines.push(
			doc.hub === null
				? "hub: none"
				: `hub: ${doc.hub}${doc.hubFrom === "created" ? " (created)" : doc.hubFrom === "judge" ? " (placed by the judge)" : ""}`,
		);
		lines.push(
			`sources: ${doc.sources.join(", ")}` +
				(doc.droppedSources.length === 0
					? ""
					: ` (dropped ${doc.droppedSources.join(", ")})`),
		);
		lines.push(
			`rels: ${doc.outlinks.length} outgoing, ${doc.backlinks.length} incoming, ${doc.unresolved.length} unresolved` +
				(doc.unresolved.length === 0 ? "" : ` (${doc.unresolved.join(", ")})`),
		);
	}
	if (result.draft !== undefined) {
		lines.push(`draft refused: ${result.draft.problems.join("; ")}`);
	}
	lines.push("");
	lines.push(
		`cost: llm $${result.cost.llmUsd.toFixed(4)} over ${result.cost.llmCalls} calls, ` +
			`jev ${result.cost.jevInputTokens} input tokens, web $${result.cost.webUsd.toFixed(4)}, ` +
			`write $${result.cost.writeUsd.toFixed(4)} over ${result.cost.writeCalls} calls`,
	);
	if (result.webReason !== null) {
		lines.push(`web: ${result.webReason}`);
	}
	return `${lines.join("\n")}\n`;
}
