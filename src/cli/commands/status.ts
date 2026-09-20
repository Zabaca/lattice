import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { planSync } from "../../okf/plan.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";
import { readBundle, readIndexedConcepts } from "./sync.js";

/** Tables counted by `status`, in the order they are reported. */
const COUNTS: ReadonlyArray<{ label: string; table: string }> = [
	{ label: "Concepts", table: "concepts" },
	{ label: "Chunks", table: "chunks" },
	{ label: "Embeddings", table: "chunk_embeddings" },
	{ label: "Links", table: "links" },
];

/**
 * Report what the index currently holds.
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

		lines.push("");
		lines.push(
			total === 0
				? "Nothing indexed yet. Run `lattice sync` to index your documents."
				: `Documents live in ${paths.docs}.`,
		);

		if (existsSync(paths.docs)) {
			const plan = planSync(readBundle(paths.docs), readIndexedConcepts(db));
			const pending =
				plan.added.length +
				plan.changed.length +
				plan.deleted.length +
				plan.renamed.length;

			lines.push("");
			lines.push(
				pending === 0
					? "Up to date with the bundle."
					: `Pending sync: ${plan.added.length} new, ${plan.changed.length} changed, ${plan.deleted.length} deleted, ${plan.renamed.length} renamed.`,
			);
		}

		const problems = db
			.query<{ path: string; frontmatter_error: string }, []>(
				"SELECT path, frontmatter_error FROM concepts WHERE frontmatter_error IS NOT NULL ORDER BY path",
			)
			.all();

		if (problems.length > 0) {
			lines.push("");
			lines.push(
				`Frontmatter problems (${problems.length}) — these documents are indexed anyway:`,
			);
			for (const problem of problems) {
				lines.push(
					`  ${problem.path}: ${firstLine(problem.frontmatter_error)}`,
				);
			}
		}

		return { code: 0, stdout: `${lines.join("\n")}\n` };
	} finally {
		db.close();
	}
}

/** YAML errors run to several lines; the first one says what went wrong. */
function firstLine(message: string): string {
	return message.split("\n", 1)[0];
}
