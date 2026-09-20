import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
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
				? "Nothing indexed yet. Run `lattice index` to index your documents."
				: `Documents live in ${paths.docs}.`,
		);

		return { code: 0, stdout: `${lines.join("\n")}\n` };
	} finally {
		db.close();
	}
}
