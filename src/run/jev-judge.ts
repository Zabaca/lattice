/**
 * TypeSafe's Jev as the runner's judge: one request per visit to the `judge`
 * state, with a Noul per candidate, a Score for completeness, a Noul for
 * whether the queries are going round in circles, and a Choice for what to
 * do next. Every question sees the same state, so the candidates are read
 * against each other and against the queries that found them.
 */

import {
	AuthenticationError,
	choice,
	noul,
	PermissionDeniedError,
	score,
	TypeSafeClient,
} from "@typesafe-ai/sdk";
import {
	API_KEY_VAR,
	DEFAULT_RERANK_MODEL,
	RERANK_MODEL_VAR,
} from "../rerank/jev.js";
import { RerankConfigurationError } from "../rerank/provider.js";
import {
	type Candidate,
	COMPLETENESS_LEVELS,
	type Judge,
	type Transition,
	type Verdict,
} from "./judge.js";

/** Noul probability a candidate needs to be kept. */
const KEEP_BAR = 0.5;
/** How much of a candidate Jev reads; a page's highlights fit, a page does not. */
const TEXT_LIMIT = 1500;

const RELEVANCE = {
	true: "It states a specific fact or design the question asks about.",
	false: "It is only on a related topic or too vague to cite.",
};

const TRANSITIONS = {
	answer: "Enough relevant candidates exist to write the document now.",
	rewrite:
		"The candidates miss the point; a differently worded query is needed.",
	give_up: "The question is unanswerable from searchable sources.",
};

export class JevJudge implements Judge {
	readonly name = "jev";
	readonly model: string;
	private readonly client: TypeSafeClient;

	constructor(options: { apiKey: string; model: string; baseURL?: string }) {
		this.model = options.model;
		this.client = new TypeSafeClient({
			apiKey: options.apiKey,
			baseURL: options.baseURL,
			logLevel: "off",
		});
	}

	async judge(
		question: string,
		tried: string[],
		candidates: Candidate[],
	): Promise<Verdict> {
		const ids = candidates.map((_, index) => `c${index + 1}`);
		const perCandidate: Record<string, ReturnType<typeof noul>> = {};
		ids.forEach((id) => {
			perCandidate[id] = noul(
				`Does candidate ${id} contain information that answers the research question?`,
				RELEVANCE,
			);
		});
		const questions = {
			...perCandidate,
			completeness: score(
				"Taken together, how completely do the candidates answer the research question?",
				[...COMPLETENESS_LEVELS],
			),
			repeating: noul(
				"Are the tried queries near-duplicates of each other, so that another rewrite is unlikely to help?",
			),
			next: choice("What should the search runner do next?", TRANSITIONS),
		};

		let result: Awaited<ReturnType<TypeSafeClient["systemOne"]>>;
		try {
			result = await this.client.systemOne({
				state: {
					researchQuestion: question,
					queriesTried: tried,
					candidates: candidates.map((candidate, index) => ({
						id: ids[index],
						source: candidate.source,
						title: candidate.title,
						text: candidate.text.slice(0, TEXT_LIMIT),
					})),
				},
				questions,
				model: this.model,
			});
		} catch (error) {
			if (
				error instanceof AuthenticationError ||
				error instanceof PermissionDeniedError
			) {
				throw new RerankConfigurationError(
					`TypeSafe rejected ${API_KEY_VAR} (${error.status}): ${error.message}`,
				);
			}
			throw error;
		}

		const answers = result.answers as Record<
			string,
			| { type: "noul"; noul: number }
			| { type: "score"; score: number; legend: Record<string, string> }
			| {
					type: "choice";
					choice: string;
					confidence: number;
					probabilities: Record<string, number>;
			  }
		>;
		const kept: string[] = [];
		candidates.forEach((candidate, index) => {
			const answer = answers[ids[index]];
			if (answer?.type === "noul" && answer.noul >= KEEP_BAR) {
				kept.push(candidate.ref);
			}
		});
		const completeness = answers.completeness;
		const repeating = answers.repeating;
		const next = answers.next;
		if (
			completeness?.type !== "score" ||
			repeating?.type !== "noul" ||
			next?.type !== "choice"
		) {
			throw new Error("Jev answered with the wrong shape.");
		}
		return {
			kept,
			completeness: completeness.score,
			completenessLabel:
				completeness.legend[String(Math.round(completeness.score))] ??
				COMPLETENESS_LEVELS[
					Math.min(
						COMPLETENESS_LEVELS.length - 1,
						Math.max(0, Math.round(completeness.score)),
					)
				],
			repeating: repeating.noul,
			next: next.choice as Transition,
			confidence: next.confidence,
			probabilities: next.probabilities as Record<Transition, number>,
			model: result.model,
			inputTokens: result.usage.input_tokens,
		};
	}
}

/** The Jev judge as the environment configures it; no key is an error. */
export function jevJudgeFromEnv(
	env: Record<string, string | undefined>,
): JevJudge {
	const apiKey = env[API_KEY_VAR]?.trim();
	if (!apiKey) {
		throw new Error(
			`The jev judge needs ${API_KEY_VAR} set to a TypeSafe API key.`,
		);
	}
	return new JevJudge({
		apiKey,
		model: env[RERANK_MODEL_VAR]?.trim() || DEFAULT_RERANK_MODEL,
		baseURL: env.TYPESAFE_BASE_URL?.trim() || undefined,
	});
}
