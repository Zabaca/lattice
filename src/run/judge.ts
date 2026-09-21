/**
 * Who says whether the search has found enough.
 *
 * The runner puts the question, the queries tried so far and every candidate
 * in front of a judge once per `judge` state and gets back one verdict: which
 * candidates are worth keeping, which dropped pages are worth reading in
 * full, how complete the set is, whether the queries have started repeating,
 * and what the judge would do next. The runner's
 * policy, not the judge, then decides the transition.
 *
 * `jev` is the real one, TypeSafe's Jev behind `TYPESAFE_API_KEY`. `stub`
 * consumes the verdicts `LATTICE_JUDGE_STUB` scripts, in order.
 */

import { jevJudgeFromEnv } from "./jev-judge.js";
import { STUB_JUDGE, stubJudgeFromEnv } from "./stub-judge.js";

export const JUDGE_PROVIDER_VAR = "LATTICE_JUDGE_PROVIDER";

export type Source = "index" | "web";

export interface Candidate {
	source: Source;
	title: string;
	/** A bundle path for the index, a URL for the web; unique within a run. */
	ref: string;
	text: string;
	/** True when `text` is passages from the page read in full rather than a search excerpt. */
	read?: boolean;
	/** The web leg that found the page, when several were searched; the first to find it, as the runner dedupes. */
	leg?: string;
}

export type Transition = "answer" | "rewrite" | "give_up";

export interface Verdict {
	/** The refs of the candidates the judge would cite. */
	kept: string[];
	/** Web candidates not kept whose full page the judge thinks likely holds the answer, most likely first. */
	read: string[];
	/** Expected completeness on the four-level rubric, 0 to 3. */
	completeness: number;
	completenessLabel: string;
	/** Probability that the tried queries are near-duplicates of each other. */
	repeating: number;
	next: Transition;
	confidence: number;
	probabilities: Record<Transition, number>;
	model: string;
	inputTokens: number;
}

/** The rubric, in the order the score counts it. */
export const COMPLETENESS_LEVELS = [
	"Nothing relevant",
	"A partial answer with major gaps",
	"Most of the answer, minor gaps",
	"A complete answer",
] as const;

/** A topic hub the research might belong under: its path, and what it says it is about. */
export interface HubCandidate {
	path: string;
	title: string;
	description: string;
}

export interface Placement {
	/** The hub the question belongs under, or null when none of the candidates fits. */
	hub: string | null;
	/** How sure the judge was of that hub; 0 when none. */
	probability: number;
	model: string;
	inputTokens: number;
}

export interface Judge {
	readonly name: string;
	judge(
		question: string,
		tried: string[],
		candidates: Candidate[],
	): Promise<Verdict>;
	/**
	 * Which of a few hubs the question belongs under, if any. The caller
	 * shortlists — the bundle's hubs grow, a request should not — and the
	 * judge reads the shortlist against the question.
	 */
	place(question: string, hubs: HubCandidate[]): Promise<Placement>;
}

/**
 * The judge the environment names; nothing set means Jev.
 *
 * An unknown name, `jev` with no key and a malformed stub all throw: a
 * runner with no judge has no loop to run.
 */
export function selectJudge(env: Record<string, string | undefined>): Judge {
	const name = env[JUDGE_PROVIDER_VAR]?.trim() || "jev";
	if (name === "jev") {
		return jevJudgeFromEnv(env);
	}
	if (name === STUB_JUDGE) {
		return stubJudgeFromEnv(env);
	}
	throw new Error(
		`Unknown judge in ${JUDGE_PROVIDER_VAR}: ${name}. Known judges: jev, ${STUB_JUDGE}.`,
	);
}
