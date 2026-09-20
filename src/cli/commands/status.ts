import { existsSync, readFileSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { selectProvider } from "../../embed/provider.js";
import { pendingChunkCount } from "../../embed/run.js";
import {
	describeSpace,
	embeddedChunkCount,
	readActiveSpace,
	sameSpace,
	type VectorSpace,
} from "../../embed/state.js";
import { planSync } from "../../sync/index.js";
import { parseConcept } from "../../sync/okf.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Report what the index holds, what a sync would change, and which files
 * Lattice could not read as OKF.
 */
export function runStatus(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const db = openDatabase(paths.database);
	try {
		// `status` is the command someone runs when something is wrong, so a
		// provider that cannot be built is reported rather than thrown: every
		// count below is still worth reading without it.
		let configured: VectorSpace | undefined;
		let source = "";
		let problem: string | undefined;
		try {
			const provider = selectProvider(context.env);
			configured = { model: provider.model, dim: provider.dim };
			source = provider.source;
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}

		// The space the index is IN, which is not always the one configured.
		const active = readActiveSpace(db) ?? configured;

		const concepts = tableCount(db, "concepts");

		// Embeddings are counted in the active space alone: a re-embed in
		// flight has two spaces on disk, and their sum is not a number that
		// means anything.
		const counts = [
			{ label: "Concepts", n: concepts },
			{ label: "Chunks", n: tableCount(db, "chunks") },
			{
				label: "Embeddings",
				n: active === undefined ? 0 : embeddedChunkCount(db, active),
			},
			{ label: "Links", n: tableCount(db, "links") },
		];

		const width = Math.max(...counts.map((entry) => entry.label.length)) + 1;
		const lines = [`Index: ${paths.database}`, ""];
		for (const { label, n } of counts) {
			lines.push(`${`${label}:`.padEnd(width)} ${n}`);
		}

		// The model and its dimensions, plus the backlog, are what separate a
		// partial index from a complete one at a glance.
		lines.push("");
		if (active === undefined) {
			lines.push("Model:  unavailable");
		} else {
			lines.push(`Model:  ${active.model} (${active.dim} dimensions)`);
			if (configured !== undefined && !sameSpace(active, configured)) {
				lines.push(
					`Configured: ${describeSpace(configured)} (from ${source})` +
						" — run `lattice embed --reembed` to rebuild the index with it.",
				);
			}
			lines.push(`Awaiting vectors: ${pendingChunkCount(db, active)}`);
		}
		if (problem !== undefined) {
			lines.push(`Embeddings are not ready yet: ${problem}`);
		}

		// Permanently failed targets are not in the backlog — nothing will pick
		// them up again on its own — so they are counted where they cannot be
		// mistaken for work still queued.
		const permanent = active === undefined ? 0 : permanentFailures(db, active);
		if (permanent > 0) {
			lines.push(
				`Permanently failed: ${permanent} (run \`lattice embed --retry-failed\` to try again)`,
			);
		}

		const plan = planSync(db, paths.docs);
		const pending =
			plan.added.length +
			plan.changed.length +
			plan.renamed.length +
			plan.deleted.length;

		lines.push("");
		lines.push(`Bundle: ${paths.docs}`);
		if (pending === 0) {
			lines.push(
				concepts === 0
					? "Nothing indexed yet. Put markdown in the bundle and run `lattice sync`."
					: "Up to date.",
			);
		} else {
			lines.push(`New:     ${plan.added.length}`);
			lines.push(`Changed: ${plan.changed.length}`);
			lines.push(`Renamed: ${plan.renamed.length}`);
			lines.push(`Deleted: ${plan.deleted.length}`);
			lines.push("Run `lattice sync` to apply.");
		}

		const problems = frontmatterProblems(db, plan);
		if (problems.length > 0) {
			lines.push("");
			lines.push(`Frontmatter problems (${problems.length}):`);
			for (const problem of problems) {
				lines.push(`  ${problem.path}: ${problem.problem}`);
			}
		}

		return { code: 0, stdout: `${lines.join("\n")}\n` };
	} finally {
		db.close();
	}
}

function tableCount(
	db: ReturnType<typeof openDatabase>,
	table: string,
): number {
	return (
		db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
			?.n ?? 0
	);
}

/**
 * Problems already recorded in the index, plus the ones a file not yet
 * indexed would produce — so a first `status` warns before the first sync.
 */
function frontmatterProblems(
	db: ReturnType<typeof openDatabase>,
	plan: ReturnType<typeof planSync>,
): Array<{ path: string; problem: string }> {
	const problems = db
		.query<{ path: string; problem: string }, []>(
			"SELECT path, frontmatter_error AS problem FROM concepts WHERE frontmatter_error IS NOT NULL",
		)
		.all();

	const known = new Set(problems.map((problem) => problem.path));
	for (const file of [...plan.added, ...plan.changed]) {
		if (known.has(file.path)) {
			continue;
		}
		const problem = readProblem(file.absolutePath);
		if (problem !== undefined) {
			problems.push({ path: file.path, problem });
		}
	}

	return problems.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Chunks and concepts recorded as failing in a way a retry will not fix. */
function permanentFailures(
	db: ReturnType<typeof openDatabase>,
	space: VectorSpace,
): number {
	return (
		db
			.query<{ n: number }, [string, number, string, number]>(
				"SELECT (SELECT count(*) FROM chunk_embed_failures" +
					" WHERE retryable = 0 AND model = ? AND dim = ?)" +
					" + (SELECT count(*) FROM concept_embed_failures" +
					" WHERE retryable = 0 AND model = ? AND dim = ?) AS n",
			)
			.get(space.model, space.dim, space.model, space.dim)?.n ?? 0
	);
}

function readProblem(absolutePath: string): string | undefined {
	return parseConcept(readFileSync(absolutePath, "utf8")).problem;
}
