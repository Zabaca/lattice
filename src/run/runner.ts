/**
 * The search loop as a state machine.
 *
 *   plan → search → judge → [read → judge] → { answer | rewrite → search … | give_up | decide }
 *
 * Code drives, the judge judges, and a language model is called only in the
 * two states that turn prose into queries. `read` is the one state that
 * goes back to the web for more of a page: a search excerpt is one short
 * highlight, and when the judge drops a page while saying the page itself
 * probably holds the answer, the page is fetched, chunked and ranked, and
 * the judge reads the best passages instead. The judge's verdict is advice; the
 * policy in `transition` is what moves the machine, and it corrects the one
 * habit the spike showed — a judge that says `answer` over a set it itself
 * rated incomplete. A rewrite is bounded by the budget and by the repeating
 * check, whichever trips first.
 *
 * Everything the loop touches comes in through `RunnerDeps`, so a test can
 * script the searches, the judge and the model and watch the transitions.
 */

import type { TextProvider } from "../llm/provider.js";
import { queriesFrom } from "../llm/provider.js";
import type { Candidate, Judge, Transition, Verdict } from "./judge.js";

/** Rewrites allowed when the caller does not say. */
export const DEFAULT_MAX_REWRITES = 2;
/** A repeating probability at or above this stops rewriting: another rewrite would say the same thing. */
const REPEATING_BAR = 0.7;
/** Below this completeness, `answer` is early and is treated as `rewrite`. */
const COMPLETE_ENOUGH = 2;
/** Choice confidence needed to follow the judge; below it the caller decides. */
const CONFIDENCE_BAR = 0.6;
/** Pages read in full after one judge visit; a bad round must not read the whole web. */
const READ_BUDGET = 2;

export type Exit = Transition | "decide";

export interface WebSearch {
	candidates: Candidate[];
	costUsd: number | null;
}

export interface PageRead {
	/** The page's best passages for the question, in page order. */
	passages: string[];
	costUsd: number | null;
}

export interface RunnerDeps {
	/** Absent when the caller asked for the web alone. */
	searchIndex?(query: string): Promise<Candidate[]>;
	/**
	 * Absent when the caller asked for the index alone. Throwing is not fatal
	 * to the run. `round` is how many rewrites came before this query: 0 on
	 * the planned queries, so a caller can search harder once a round has
	 * failed.
	 */
	searchWeb?(query: string, round: number): Promise<WebSearch>;
	/** Absent when pages cannot be read in full. Throwing costs that page, not the run. */
	readPage?(question: string, url: string): Promise<PageRead>;
	judge: Judge;
	llm: TextProvider;
}

/**
 * What the planner is shown before it writes its queries. Both are prose the
 * caller composes; neither names a hub, a URL or a path, because the loop
 * knows nothing about bundles. The instruction wrapped around each is the
 * plan state's, since that wording is what moves the queries.
 */
export interface PlanContext {
	/** A source the run already holds and will cite; its subject is the run's subject. */
	held?: string;
	/** What the bundle already holds on the subject: background saying what it is. */
	known?: string;
}

export interface RunOptions {
	question: string;
	/**
	 * Queries to search instead of planning; the plan state is skipped when
	 * given. `lattice run --tried` is what passes them; research plans each
	 * of its loops for itself.
	 */
	tried?: string[];
	maxRewrites: number;
	/**
	 * Candidates the caller already has, judged in the first visit alongside
	 * whatever the first queries find. A page the user named is the case:
	 * it is evidence the run was given rather than evidence it went looking
	 * for, so it never has to be searched up.
	 */
	seeded?: Candidate[];
	/** What the planner and the rewriter should know before they write queries. */
	context?: PlanContext;
}

export interface JudgeRecord {
	queries: string[];
	/** Pages read in full before this visit, when it is a re-read of them. */
	read: string[];
	/** How many candidates the judge read: everything kept so far plus this round's finds. */
	candidates: number;
	/** Everything kept so far, after this verdict. */
	kept: string[];
	/** This round's finds the judge would not cite. */
	dropped: number;
	completeness: number;
	repeating: number;
	next: Transition;
	confidence: number;
	probabilities: Record<Transition, number>;
	model: string;
	inputTokens: number;
}

export interface RunResult {
	question: string;
	exit: Exit;
	tried: string[];
	completeness: number;
	completenessLabel: string;
	kept: Candidate[];
	records: JudgeRecord[];
	cost: {
		llmUsd: number;
		llmCalls: number;
		jevInputTokens: number;
		webUsd: number;
	};
	/** Why the web leg stopped, when it did; the run went on over the index. */
	webReason: string | null;
}

export async function runLoop(
	deps: RunnerDeps,
	options: RunOptions,
): Promise<RunResult> {
	const { question } = options;
	const cost = { llmUsd: 0, llmCalls: 0, jevInputTokens: 0, webUsd: 0 };
	const tried: string[] = [];
	const records: JudgeRecord[] = [];
	const seen = new Map<string, Candidate>();
	let kept: Candidate[] = [];
	let searchWeb = deps.searchWeb;
	let webReason: string | null = null;
	let rewrites = 0;
	let verdict: Verdict | undefined;
	let exit: Exit;

	const ask = async (prompt: string): Promise<string[]> => {
		const completion = await deps.llm.complete(prompt);
		cost.llmUsd += completion.costUsd;
		cost.llmCalls++;
		return queriesFrom(completion.text);
	};

	// plan
	let queries =
		options.tried !== undefined && options.tried.length > 0
			? options.tried
			: await ask(planPrompt(question, options.context));

	// Seeded candidates are in the set before the first query runs, so the
	// first verdict is over them and whatever the search adds.
	const seeded: Candidate[] = [];
	for (const candidate of options.seeded ?? []) {
		const key = candidateKey(candidate);
		if (!seen.has(key)) {
			seen.set(key, candidate);
			seeded.push(candidate);
		}
	}

	for (;;) {
		// search: every query over both legs, merged, first occurrence kept.
		const fresh: Candidate[] = seeded.splice(0, seeded.length);
		for (const query of queries) {
			tried.push(query);
			const found =
				deps.searchIndex === undefined ? [] : await deps.searchIndex(query);
			if (searchWeb !== undefined) {
				try {
					const web = await searchWeb(query, rewrites);
					cost.webUsd += web.costUsd ?? 0;
					found.push(...web.candidates);
				} catch (error) {
					// A key that is missing now will be missing on the next query
					// too; the index is what is left, as it is for a search whose
					// semantic leg could not run.
					webReason = error instanceof Error ? error.message : String(error);
					searchWeb = undefined;
				}
			}
			for (const candidate of found) {
				const key = candidateKey(candidate);
				if (!seen.has(key)) {
					seen.set(key, candidate);
					fresh.push(candidate);
				}
			}
		}

		// judge: what survived the last verdict, plus what this round found.
		// Sending the whole history again would grow the state on every
		// visit and blunt the judge with candidates it already dropped. The
		// set is judged whole, so completeness is about everything kept; a
		// candidate's own relevance is settled the first time the judge reads
		// it, because the spike showed that verdict flipping on a re-read.
		// The one exception is a page read in full: its text has changed, so
		// it comes back once as a new candidate.
		let round = fresh;
		let read: string[] = [];
		let candidates: Candidate[];
		for (;;) {
			candidates = dedupe([...kept, ...round]);
			verdict = await deps.judge.judge(question, tried, candidates);
			cost.jevInputTokens += verdict.inputTokens;
			const keptRefs = new Set(verdict.kept);
			const keptNow = round.filter((candidate) => keptRefs.has(candidate.ref));
			kept = dedupe([...kept, ...keptNow]);
			records.push({
				queries,
				read,
				candidates: candidates.length,
				kept: kept.map((candidate) => candidate.ref),
				dropped: round.length - keptNow.length,
				completeness: verdict.completeness,
				repeating: verdict.repeating,
				next: verdict.next,
				confidence: verdict.confidence,
				probabilities: verdict.probabilities,
				model: verdict.model,
				inputTokens: verdict.inputTokens,
			});

			// read: the pages the judge dropped on their excerpt but wants in
			// full, the likeliest few. A page that cannot be read is dropped as
			// its excerpt was; the run goes on.
			if (deps.readPage === undefined || read.length > 0) {
				break;
			}
			const byRef = new Map(
				round.map((candidate) => [candidate.ref, candidate]),
			);
			const reread: Candidate[] = [];
			for (const ref of verdict.read) {
				if (reread.length >= READ_BUDGET) {
					break;
				}
				const candidate = byRef.get(ref);
				if (
					candidate === undefined ||
					candidate.source !== "web" ||
					candidate.read === true ||
					keptRefs.has(candidate.ref)
				) {
					continue;
				}
				try {
					const page = await deps.readPage(question, candidate.ref);
					cost.webUsd += page.costUsd ?? 0;
					const full: Candidate = {
						...candidate,
						text: page.passages.join("\n\n"),
						read: true,
					};
					seen.set(candidateKey(full), full);
					reread.push(full);
				} catch {
					// The excerpt's verdict stands.
				}
			}
			if (reread.length === 0) {
				break;
			}
			round = reread;
			read = reread.map((candidate) => candidate.ref);
		}

		const next = transition(verdict, rewrites, options.maxRewrites);
		if (next === "exhausted") {
			// Out of rewrites is not the same as out of answers: what the judge
			// kept is still the best set there is.
			exit = kept.length > 0 ? "answer" : "give_up";
			break;
		}
		if (next !== "rewrite") {
			exit = next;
			break;
		}
		rewrites++;
		queries = await ask(
			rewritePrompt(
				question,
				tried,
				`completeness "${verdict.completenessLabel}"; ${candidates.length - kept.length} of ${candidates.length} candidates judged irrelevant`,
				options.context,
			),
		);
	}

	return {
		question,
		exit,
		tried,
		completeness: verdict.completeness,
		completenessLabel: verdict.completenessLabel,
		kept,
		records,
		cost,
		webReason,
	};
}

/**
 * The policy, in order. Each rule is a correction the spike showed was
 * needed, and the order is what makes them compose. An answer over a set the
 * judge itself rated incomplete is sent round again, and that override is
 * code's, so the judge's confidence in the choice it overrode does not
 * apply. Otherwise an unsure judge hands over before its choice is followed.
 * And only a loop that has already rewritten once is asked whether rewriting
 * has stopped helping: two planned queries on one topic always look alike,
 * and a loop cannot be stuck before it has looped. A rewrite that would not
 * help is `exhausted`, the same stop as an empty budget: the loop ends over
 * what it kept.
 */
export function transition(
	verdict: Verdict,
	rewrites: number,
	maxRewrites: number,
): Exit | "exhausted" {
	const corrected =
		verdict.completeness < COMPLETE_ENOUGH && verdict.next === "answer";
	if (!corrected && verdict.confidence < CONFIDENCE_BAR) {
		return "decide";
	}
	const choice: Transition = corrected ? "rewrite" : verdict.next;
	if (choice !== "rewrite") {
		return choice;
	}
	if (rewrites >= maxRewrites) {
		return "exhausted";
	}
	if (rewrites > 0 && verdict.repeating >= REPEATING_BAR) {
		return "exhausted";
	}
	return "rewrite";
}

/**
 * The context as the planner reads it. A held source fixes the subject: the
 * queries worth spending are the ones that corroborate or extend it, not the
 * ones that chase whatever the question mentions and the source does not —
 * a probe showed "what it leaves out" sending the planner after a name no
 * source could explain. What the bundle knows is vocabulary: searching in
 * the words that describe a subject is what keeps a namesake out of the
 * results, so the instruction asks for the name with its qualifiers rather
 * than forbidding the name.
 */
function contextBlocks(context?: PlanContext): string {
	const blocks: string[] = [];
	if (context?.held !== undefined) {
		blocks.push(
			`This source is already held and will be cited, so its subject is the subject of the run. ` +
				`Write queries that corroborate what it says, carry it further, or explain what it names in passing. ` +
				`Do not write a query for something the question mentions that this source does not discuss:\n\n${context.held}\n\n`,
		);
	}
	if (context?.known !== undefined) {
		blocks.push(
			`This is what the bundle already holds on the subject: background that says what the subject is, not the answer. ` +
				`Search in the words that describe it — what kind of thing it is, what it does, what it is built on — ` +
				`rather than its bare name, so that something else sharing the name is not what comes back:\n\n${context.known}\n\n`,
		);
	}
	if (blocks.length === 2) {
		blocks.push(
			`Let one query follow from the held source and one from what the bundle knows. `,
		);
	}
	return blocks.join("");
}

export function planPrompt(question: string, context?: PlanContext): string {
	const blocks = contextBlocks(context);
	const base = `Write two distinct search queries that together would find sources answering: "${question}". `;
	const anchor =
		blocks === ""
			? ""
			: `The question is what the queries must answer; what is above is there to say what it is about. `;
	return `${blocks}${base}${anchor}Return JSON only: {"queries": ["...", "..."]}`;
}

export function rewritePrompt(
	question: string,
	tried: string[],
	reason: string,
	context?: PlanContext,
): string {
	const blocks = contextBlocks(context);
	// The rewrite is the call that most needs the context: it fires exactly
	// when the namesakes were judged irrelevant, and blind it hunts the same
	// name in different words.
	const instruction =
		blocks === ""
			? `Write two new, different queries. `
			: `Write two new, different queries on the same subject: change how you ask, not what you are asking about. `;
	return (
		`${blocks}The research question is: "${question}". These queries were tried: ${JSON.stringify(tried)}. ` +
		`A judge said the results were insufficient because: ${reason}. ` +
		`${instruction}Return JSON only: {"queries": ["...", "..."]}`
	);
}

/** What makes two candidates the same: a path for the index, a canonical URL for the web. */
export function candidateKey(candidate: Candidate): string {
	return candidate.source === "web"
		? `web:${canonicalUrl(candidate.ref)}`
		: `index:${candidate.ref}`;
}

function dedupe(candidates: Candidate[]): Candidate[] {
	const byKey = new Map<string, Candidate>();
	for (const candidate of candidates) {
		const key = candidateKey(candidate);
		if (!byKey.has(key)) {
			byKey.set(key, candidate);
		}
	}
	return [...byKey.values()];
}

/**
 * The same page under its spellings: scheme and `www.` dropped, the host
 * lowercased, a trailing slash and a fragment ignored. The query string is
 * kept, since on many sites it is the page.
 */
export function canonicalUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
		const path = parsed.pathname.replace(/\/+$/, "");
		return `${host}${path}${parsed.search}`;
	} catch {
		return url.trim().toLowerCase();
	}
}
