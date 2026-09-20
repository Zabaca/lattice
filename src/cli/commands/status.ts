import { existsSync, readFileSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { planSync } from "../../sync/index.js";
import { parseConcept } from "../../sync/okf.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/** Tables counted by `status`, in the order they are reported. */
const COUNTS: ReadonlyArray<{ label: string; table: string }> = [
	{ label: "Concepts", table: "concepts" },
	{ label: "Chunks", table: "chunks" },
	{ label: "Embeddings", table: "chunk_embeddings" },
	{ label: "Links", table: "links" },
];

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
		const width = Math.max(...COUNTS.map((entry) => entry.label.length)) + 1;
		const lines = [`Index: ${paths.database}`, ""];
		let total = 0;

		for (const { label, table } of COUNTS) {
			const row = db
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
				.get();
			const count = row?.n ?? 0;
			total += count;
			lines.push(`${`${label}:`.padEnd(width)} ${count}`);
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
				total === 0
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

function readProblem(absolutePath: string): string | undefined {
	return parseConcept(readFileSync(absolutePath, "utf8")).problem;
}
