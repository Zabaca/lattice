/**
 * TypeSafe's Jev as the runner's judge: one request per visit to the `judge`
 * state, with a Noul per candidate, a second Noul per web page still known
 * only by its excerpt, a Score for completeness, a Noul for whether the
 * queries are going round in circles, and a Choice for what to do next. Every question sees the same state, so the candidates are read
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
	type HubCandidate,
	type Judge,
	type Placement,
	type Transition,
	type Verdict,
} from "./judge.js";

/** Noul probability a candidate needs to be kept. */
const KEEP_BAR = 0.5;
/**
 * Noul probability below which a dropped page is not worth reading. It is a
 * floor, not a bar: Jev's answers to this question sit in a narrow band, so
 * the pages above it are ranked and the runner reads the best few.
 */
const READ_FLOOR = 0.3;
/**
 * Noul probability a hub needs before the research is filed under it. On
 * the bundle's hubs a true subject scored 0.87–0.97 and a hub that merely
 * shared the field (Exa for a question on rank fusion) 0.38–0.57, so the
 * bar sits in the gap with room on both sides.
 */
const PLACE_BAR = 0.75;
/** How much of a candidate Jev reads; a page's highlights fit, a page does not. */
const TEXT_LIMIT = 1500;
/** A page read in full arrives as a few ranked passages, which are worth more room. */
const READ_TEXT_LIMIT = 6000;

const RELEVANCE = {
	true: "It states a specific fact or design the question asks about.",
	false: "It is only on a related topic or too vague to cite.",
};

/**
 * Why the candidate question asks about relevance rather than about
 * answering.
 *
 * Asked whether a candidate "contains information that answers" the
 * question, Jev reads the question's own words as a specification the page
 * must meet. A question whose premise is false then has no citable source
 * at all: on "how does FTS5 rank with bm25 inside a window function" the
 * FTS5 reference scored 0.23, even on the passage saying the rank column is
 * NULL outside a MATCH query — the rule that settles it. Every page was
 * dropped and the run gave up. Rewording the legend did not move it (0.24
 * widened, 0.43 at its loosest, and the tangential window-functions page
 * rose with it); dropping the two words from the question moved the same
 * page to 0.95. So the fix is the stem, not the legend: asked what is
 * relevant to answering, Jev scores the reference 0.61 and the
 * window-functions page 0.22, a gap of 0.39 against 0.12. Over topics that
 * already worked it changes no verdict at all, and a page on sourdough
 * injected into each set stays at 0.01.
 */
const candidateQuestion = (id: string): string =>
	`Is candidate ${id} relevant to answering the research question?`;

const WORTH_READING = {
	true: "The page as a whole probably covers what the question asks, and the excerpt is just the wrong part of it.",
	false:
		"The page is off the topic, or the excerpt already shows what it has to say.",
};

const BELONGS = {
	true: "The hub's subject is what the question is about, or the thing it is a question about; research on it would be listed under this hub.",
	false:
		"The hub is on a different subject, even one in the same field, using the same technique, or sharing a word with the question.",
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
		ids.forEach((id, index) => {
			perCandidate[id] = noul(candidateQuestion(id), RELEVANCE);
			const candidate = candidates[index];
			if (candidate.source === "web" && candidate.read !== true) {
				perCandidate[`${id}_read`] = noul(
					`Judging by its title and excerpt, would the full page behind candidate ${id} be worth reading for the research question?`,
					WORTH_READING,
				);
			}
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
						...(candidate.read === true ? { read: true } : {}),
						text: candidate.text.slice(
							0,
							candidate.read === true ? READ_TEXT_LIMIT : TEXT_LIMIT,
						),
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
		const worthReading: { ref: string; probability: number }[] = [];
		candidates.forEach((candidate, index) => {
			const answer = answers[ids[index]];
			if (answer?.type === "noul" && answer.noul >= KEEP_BAR) {
				kept.push(candidate.ref);
				return;
			}
			const worth = answers[`${ids[index]}_read`];
			if (worth?.type === "noul" && worth.noul >= READ_FLOOR) {
				worthReading.push({ ref: candidate.ref, probability: worth.noul });
			}
		});
		const read = worthReading
			.sort((a, b) => b.probability - a.probability)
			.map((entry) => entry.ref);
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
			read,
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

	place(question: string, hubs: HubCandidate[]): Promise<Placement> {
		return placeWith(this.client, this.model, question, hubs);
	}
}

/** One request over a shortlist of hubs: a Noul each, the best above the bar wins. */
async function placeWith(
	client: TypeSafeClient,
	model: string,
	question: string,
	hubs: HubCandidate[],
): Promise<Placement> {
	if (hubs.length === 0) {
		return { hub: null, probability: 0, model, inputTokens: 0 };
	}
	const ids = hubs.map((_, index) => `h${index + 1}`);
	const questions: Record<string, ReturnType<typeof noul>> = {};
	ids.forEach((id) => {
		questions[id] = noul(
			`Does the research question belong under hub ${id}?`,
			BELONGS,
		);
	});
	let result: Awaited<ReturnType<TypeSafeClient["systemOne"]>>;
	try {
		result = await client.systemOne({
			state: {
				researchQuestion: question,
				hubs: hubs.map((hub, index) => ({
					id: ids[index],
					title: hub.title,
					description: hub.description,
				})),
			},
			questions,
			model,
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
		{ type: "noul"; noul: number } | undefined
	>;
	let best: { path: string; probability: number } | undefined;
	hubs.forEach((hub, index) => {
		const answer = answers[ids[index]];
		if (
			answer?.type === "noul" &&
			(best === undefined || answer.noul > best.probability)
		) {
			best = { path: hub.path, probability: answer.noul };
		}
	});
	return {
		hub: best !== undefined && best.probability >= PLACE_BAR ? best.path : null,
		probability: best?.probability ?? 0,
		model: result.model,
		inputTokens: result.usage.input_tokens,
	};
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
