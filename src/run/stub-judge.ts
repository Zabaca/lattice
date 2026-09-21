/**
 * A judge that can be told its verdicts.
 *
 * `LATTICE_JUDGE_STUB` is a JSON array of verdicts consumed one per visit to
 * the `judge` state, the last repeating once they run out. Each is
 * `{ keep, completeness, repeating, next, confidence, read? }`, where `keep`
 * and `read` list substrings: a candidate is kept when its ref contains one
 * of `keep`, and a web candidate not kept is read in full when its ref
 * contains one of `read`.
 *
 * It is named `stub` in the environment so it can never be selected by
 * accident.
 */

import {
	type Candidate,
	COMPLETENESS_LEVELS,
	type Judge,
	type Transition,
	type Verdict,
} from "./judge.js";

export const STUB_JUDGE = "stub";
export const STUB_VERDICTS_VAR = "LATTICE_JUDGE_STUB";

export interface StubVerdict {
	keep: string[];
	read?: string[];
	completeness: number;
	repeating: number;
	next: Transition;
	confidence: number;
}

const TRANSITIONS: Transition[] = ["answer", "rewrite", "give_up"];

export class StubJudge implements Judge {
	readonly name = STUB_JUDGE;
	private readonly verdicts: StubVerdict[];
	private calls = 0;

	constructor(verdicts: StubVerdict[]) {
		this.verdicts = verdicts;
	}

	async judge(
		_question: string,
		_tried: string[],
		candidates: Candidate[],
	): Promise<Verdict> {
		const scripted =
			this.verdicts[Math.min(this.calls, this.verdicts.length - 1)];
		this.calls++;
		// The rest of the mass is split evenly, so the distribution sums to one.
		const rest = (1 - scripted.confidence) / (TRANSITIONS.length - 1);
		const probabilities = {} as Record<Transition, number>;
		for (const transition of TRANSITIONS) {
			probabilities[transition] =
				transition === scripted.next ? scripted.confidence : rest;
		}
		const keptSet = new Set(
			candidates
				.filter((candidate) =>
					scripted.keep.some((needle) => candidate.ref.includes(needle)),
				)
				.map((candidate) => candidate.ref),
		);
		return {
			kept: [...keptSet],
			read: candidates
				.filter(
					(candidate) =>
						candidate.source === "web" &&
						candidate.read !== true &&
						!keptSet.has(candidate.ref) &&
						(scripted.read ?? []).some((needle) =>
							candidate.ref.includes(needle),
						),
				)
				.map((candidate) => candidate.ref),
			completeness: scripted.completeness,
			completenessLabel:
				COMPLETENESS_LEVELS[
					Math.min(
						COMPLETENESS_LEVELS.length - 1,
						Math.max(0, Math.round(scripted.completeness)),
					)
				],
			repeating: scripted.repeating,
			next: scripted.next,
			confidence: scripted.confidence,
			probabilities,
			model: "stub",
			inputTokens: 0,
		};
	}
}

/** A malformed script is an error: a stub that judged nothing would look like a run that never searched. */
export function stubJudgeFromEnv(
	env: Record<string, string | undefined>,
): StubJudge {
	const raw = env[STUB_VERDICTS_VAR]?.trim();
	if (!raw) {
		throw new Error(
			`The ${STUB_JUDGE} judge needs ${STUB_VERDICTS_VAR}: a JSON array of { keep, completeness, repeating, next, confidence }.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${STUB_VERDICTS_VAR} is not valid JSON.`);
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		!parsed.every(isVerdict)
	) {
		throw new Error(
			`${STUB_VERDICTS_VAR} must be a non-empty JSON array of { keep, completeness, repeating, next, confidence }.`,
		);
	}
	return new StubJudge(parsed);
}

function isVerdict(value: unknown): value is StubVerdict {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (
		Array.isArray(v.keep) &&
		v.keep.every((needle) => typeof needle === "string") &&
		(v.read === undefined ||
			(Array.isArray(v.read) &&
				v.read.every((needle) => typeof needle === "string"))) &&
		typeof v.completeness === "number" &&
		typeof v.repeating === "number" &&
		typeof v.next === "string" &&
		TRANSITIONS.includes(v.next as Transition) &&
		typeof v.confidence === "number"
	);
}
