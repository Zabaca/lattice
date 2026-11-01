/**
 * What the store holds, how its search is doing, and how it is being used.
 */

import type { Database } from "bun:sqlite";
import { pendingChunkCount } from "../embed/run.js";
import {
	embeddedChunkCount,
	readActiveSpace,
	sameSpace,
	type VectorSpace,
} from "../embed/state.js";

export interface SearchHealth {
	/** True when search can run fully: a model, and a vector for every passage. */
	ok: boolean;
	model: string | null;
	dim: number | null;
	passages: number;
	/** Passages with a vector in the model the store is in. */
	vectors: number;
	/** Passages waiting for one. */
	waiting: number;
	/** Passages and notes whose embedding failed for good or is waiting for a retry. */
	failed: number;
	/** What is wrong, in a sentence, when something is. */
	problem?: string;
}

/**
 * Search health: the model the store is in, how many passages have a vector in
 * it, and what stands in the way of the rest. `configured` is the model this
 * process would embed with.
 */
export function searchHealth(
	db: Database,
	configured: VectorSpace | undefined,
	configuredProblem?: string,
): SearchHealth {
	const active = readActiveSpace(db) ?? configured;
	const passages =
		db.query<{ n: number }, []>("SELECT count(*) AS n FROM chunks").get()?.n ??
		0;
	if (active === undefined) {
		return {
			ok: false,
			model: null,
			dim: null,
			passages,
			vectors: 0,
			waiting: passages,
			failed: 0,
			problem: configuredProblem ?? "no embedding model is configured",
		};
	}

	const vectors = embeddedChunkCount(db, active);
	const waiting = pendingChunkCount(db, active);
	const failed =
		db
			.query<{ n: number }, [string, number, string, number]>(
				`SELECT (SELECT count(*) FROM chunk_embed_failures WHERE model = ? AND dim = ?)
				+ (SELECT count(*) FROM concept_embed_failures WHERE model = ? AND dim = ?) AS n`,
			)
			.get(active.model, active.dim, active.model, active.dim)?.n ?? 0;

	let problem: string | undefined;
	if (configuredProblem !== undefined) {
		problem = `the embedding model cannot be used here: ${configuredProblem}`;
	} else if (configured !== undefined && !sameSpace(active, configured)) {
		problem = `the store is embedded with ${active.model} (${active.dim}) but this server would use ${configured.model} (${configured.dim}); questions run on keywords alone until \`lattice embed --reembed\``;
	} else if (waiting > 0) {
		problem = `${waiting} passages have no vector yet and are found by keyword only`;
	} else if (failed > 0) {
		problem = `${failed} embeddings failed`;
	}

	return {
		ok: problem === undefined,
		model: active.model,
		dim: active.dim,
		passages,
		vectors,
		waiting,
		failed,
		...(problem === undefined ? {} : { problem }),
	};
}

export interface Stats {
	notes: {
		total: number;
		by_type: Record<string, number>;
		archived: number;
		old: number;
	};
	sections: {
		total: number;
		unchecked: number;
		by_agent: number;
		by_james: number;
	};
	changes: {
		last_7_days: number;
		last: { change: number; note: string; at: string; kind: string } | null;
	};
	search: SearchHealth;
	/** Notes that other notes link to and nobody has written, most wanted first. */
	wanted: Array<{ note: string; wanted_by: number }>;
	/** How the store is being asked: counted from the record of questions. */
	questions: { last_7_days: number; projects: number; last: string | null };
	/** Until daily backups exist this is null. */
	last_backup: string | null;
}

export function collectStats(
	db: Database,
	configured: VectorSpace | undefined,
	configuredProblem: string | undefined,
	now: Date = new Date(),
): Stats {
	const one = <Row>(sql: string, ...values: (string | number)[]): Row | null =>
		db.query<Row, (string | number)[]>(sql).get(...values);
	const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

	const byType: Record<string, number> = {};
	for (const row of db
		.query<{ type: string; n: number }, []>(
			"SELECT type, count(*) AS n FROM concepts GROUP BY type ORDER BY n DESC",
		)
		.all()) {
		byType[row.type] = row.n;
	}

	const trust = (value: string): number =>
		one<{ n: number }>(
			"SELECT count(*) AS n FROM sections WHERE trust = ?",
			value,
		)?.n ?? 0;

	const last = one<{
		id: number;
		identifier: string;
		at: string;
		kind: string;
	}>(
		`SELECT ch.id, c.identifier, ch.at, ch.kind FROM changes ch
		JOIN concepts c ON c.id = ch.concept_id ORDER BY ch.at DESC, ch.id DESC LIMIT 1`,
	);
	const lastQuestion = one<{ at: string }>(
		"SELECT at FROM recall_log ORDER BY at DESC, id DESC LIMIT 1",
	);

	return {
		notes: {
			total: one<{ n: number }>("SELECT count(*) AS n FROM concepts")?.n ?? 0,
			by_type: byType,
			archived:
				one<{ n: number }>(
					"SELECT count(*) AS n FROM concepts WHERE archived = 1",
				)?.n ?? 0,
			old:
				one<{ n: number }>("SELECT count(*) AS n FROM tags WHERE tag = 'old'")
					?.n ?? 0,
		},
		sections: {
			total: one<{ n: number }>("SELECT count(*) AS n FROM sections")?.n ?? 0,
			unchecked: trust("unverified"),
			by_agent: trust("machine-confirmed"),
			by_james: trust("human-reviewed"),
		},
		changes: {
			last_7_days:
				one<{ n: number }>(
					"SELECT count(*) AS n FROM changes WHERE at >= ?",
					weekAgo,
				)?.n ?? 0,
			last:
				last === null
					? null
					: {
							change: last.id,
							note: last.identifier,
							at: last.at,
							kind: last.kind,
						},
		},
		search: searchHealth(db, configured, configuredProblem),
		wanted: db
			.query<{ target_path: string; n: number }, []>(
				`SELECT target_path, count(DISTINCT source_concept_id) AS n FROM links
				WHERE target_concept_id IS NULL AND target_path IS NOT NULL
				GROUP BY target_path ORDER BY n DESC, target_path LIMIT 10`,
			)
			.all()
			.map((row) => ({
				note: row.target_path.replace(/\.md$/, ""),
				wanted_by: row.n,
			})),
		questions: {
			last_7_days:
				one<{ n: number }>(
					"SELECT count(*) AS n FROM recall_log WHERE at >= ?",
					weekAgo,
				)?.n ?? 0,
			projects:
				one<{ n: number }>(
					"SELECT count(DISTINCT project) AS n FROM recall_log WHERE at >= ? AND project IS NOT NULL",
					weekAgo,
				)?.n ?? 0,
			last: lastQuestion?.at ?? null,
		},
		last_backup: null,
	};
}
