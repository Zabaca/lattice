/**
 * The search loop as a state machine.
 *
 *   plan → search → judge → { answer | rewrite → search … | give_up | decide }
 *
 * Code drives, the judge judges, and a language model is called only in the
 * two states that turn prose into queries. The judge's verdict is advice; the
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

export type Exit = Transition | "decide";

export interface WebSearch {
	candidates: Candidate[];
	costUsd: number | null;
}

export interface RunnerDeps {
	searchIndex(query: string): Promise<Candidate[]>;
	/** Absent when the caller asked for the index alone. Throwing is not fatal to the run. */
	searchWeb?(query: string): Promise<WebSearch>;
	judge: Judge;
	llm: TextProvider;
}

export interface RunOptions {
	question: string;
	/** Queries to search instead of planning; the plan state is skipped when given. */
	tried?: string[];
	maxRewrites: number;
}

export interface JudgeRecord {
	queries: string[];
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
			: await ask(planPrompt(question));

	for (;;) {
		// search: every query over both legs, merged, first occurrence kept.
		const fresh: Candidate[] = [];
		for (const query of queries) {
			tried.push(query);
			const found = await deps.searchIndex(query);
			if (searchWeb !== undefined) {
				try {
					const web = await searchWeb(query);
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
		const candidates = dedupe([...kept, ...fresh]);
		verdict = await deps.judge.judge(question, tried, candidates);
		cost.jevInputTokens += verdict.inputTokens;
		const keptRefs = new Set(verdict.kept);
		const keptNow = fresh.filter((candidate) => keptRefs.has(candidate.ref));
		kept = dedupe([...kept, ...keptNow]);
		records.push({
			queries,
			candidates: candidates.length,
			kept: kept.map((candidate) => candidate.ref),
			dropped: fresh.length - keptNow.length,
			completeness: verdict.completeness,
			repeating: verdict.repeating,
			next: verdict.next,
			confidence: verdict.confidence,
			probabilities: verdict.probabilities,
			model: verdict.model,
			inputTokens: verdict.inputTokens,
		});

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

function planPrompt(question: string): string {
	return (
		`Write two distinct search queries that together would find sources answering: "${question}". ` +
		`Return JSON only: {"queries": ["...", "..."]}`
	);
}

function rewritePrompt(
	question: string,
	tried: string[],
	reason: string,
): string {
	return (
		`The research question is: "${question}". These queries were tried: ${JSON.stringify(tried)}. ` +
		`A judge said the results were insufficient because: ${reason}. ` +
		`Write two new, different queries. Return JSON only: {"queries": ["...", "..."]}`
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
