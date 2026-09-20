/**
 * Putting two rankings together without pretending their scores are comparable.
 *
 * A BM25-derived tier score and a cosine similarity are different quantities on
 * different scales; adding or weighting them requires a calibration nobody has.
 * Reciprocal rank fusion needs none: each leg contributes `1 / (K + rank)`, so
 * only the ORDER each leg produced is used. A passage either leg ranks highly
 * survives, which is the whole point of running two.
 */

/**
 * The constant that decides how flat the contribution curve is. 60 is the
 * value the original RRF work used and what every implementation since has
 * kept; it makes first place worth about twice tenth place rather than ten
 * times, so one leg's confident top hit cannot bury the other leg entirely.
 */
const K = 60;

/** One leg's opinion: the ids it matched, best first. */
export type Ranking = number[];

/**
 * Fuse the legs into one score per id. Ids absent from a leg simply take
 * nothing from it, rather than taking a penalty.
 */
export function reciprocalRankFusion(rankings: Ranking[]): Map<number, number> {
	const scores = new Map<number, number>();
	for (const ranking of rankings) {
		ranking.forEach((id, index) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (K + index + 1));
		});
	}
	return scores;
}

/**
 * The largest nudge that cannot reorder anything.
 *
 * A tiebreak must only decide between entries the fusion left equal. So the
 * nudge is sized against the smallest gap actually present between two
 * distinct fused scores: anything smaller than half that gap can close a tie
 * and can never cross one. With no two distinct scores there is nothing to
 * cross, and any bounded nudge will do.
 */
export function tiebreakEpsilon(scores: Iterable<number>): number {
	const distinct = [...new Set(scores)].sort((a, b) => a - b);
	let smallest = Number.POSITIVE_INFINITY;
	for (let i = 1; i < distinct.length; i++) {
		smallest = Math.min(smallest, distinct[i] - distinct[i - 1]);
	}
	return Number.isFinite(smallest) ? smallest / 2 : 1 / (K * K);
}
