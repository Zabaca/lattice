import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * What one concept is connected to: the documents it links to, the documents
 * linking back at it, the documents filed beside it, and the links it makes
 * that nothing answers yet.
 *
 * The unresolved list is the point of the last of those: it is the bundle
 * telling its author which documents they have promised and not written.
 */

interface ConceptRow {
	id: number;
	path: string;
	identifier: string;
	title: string | null;
}

interface EdgeRow {
	path: string;
	identifier: string;
	title: string | null;
	kind: string;
	link_text: string | null;
	anchor: string | null;
	context: string | null;
}

interface UnresolvedRow {
	target_path: string;
	raw_target: string;
	kind: string;
	link_text: string | null;
	anchor: string | null;
	context: string | null;
}

/** The columns every edge is reported with, from the concept at its far end. */
const EDGE_COLUMNS =
	"far.path, far.identifier, far.title, l.kind, l.link_text, l.anchor, l.context";

export function runRels(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const wanted = context.positionals[0];
	const db = openDatabase(paths.database);
	try {
		const concept = findConcept(db, wanted);
		if (concept === undefined) {
			return {
				code: 1,
				stderr: `No indexed concept matches ${wanted}. Run \`lattice sync\`, or check the path.`,
			};
		}

		const outlinks = db
			.query<EdgeRow, [number]>(
				`SELECT ${EDGE_COLUMNS} FROM links l
				JOIN concepts far ON far.id = l.target_concept_id
				WHERE l.source_concept_id = ? ORDER BY l.id`,
			)
			.all(concept.id);

		const backlinks = db
			.query<EdgeRow, [number]>(
				`SELECT ${EDGE_COLUMNS} FROM links l
				JOIN concepts far ON far.id = l.source_concept_id
				WHERE l.target_concept_id = ? ORDER BY far.path, l.id`,
			)
			.all(concept.id);

		const siblings = db
			.query<Omit<ConceptRow, "id">, [number]>(
				`SELECT path, identifier, title FROM concepts
				WHERE dir = (SELECT dir FROM concepts WHERE id = ?1) AND id <> ?1
				ORDER BY path`,
			)
			.all(concept.id);

		const unresolved = db
			.query<UnresolvedRow, [number]>(
				`SELECT l.target_path, l.raw_target, l.kind, l.link_text, l.anchor, l.context
				FROM links l
				WHERE l.source_concept_id = ? AND l.target_concept_id IS NULL
				ORDER BY l.id`,
			)
			.all(concept.id);

		const report = { concept, outlinks, backlinks, siblings, unresolved };
		if (context.flags.json) {
			return { code: 0, stdout: `${JSON.stringify(report, null, 2)}\n` };
		}
		return { code: 0, stdout: reportText(report) };
	} finally {
		db.close();
	}
}

/**
 * The concept the user named, by path or by OKF identifier. `concepts/users`
 * and `concepts/users.md` are the same document, and either is a reasonable
 * thing to have copied from somewhere else.
 */
function findConcept(
	db: ReturnType<typeof openDatabase>,
	wanted: string,
): ConceptRow | undefined {
	const row = db
		.query<ConceptRow, [string, string]>(
			"SELECT id, path, identifier, title FROM concepts WHERE path = ? OR identifier = ?",
		)
		.get(wanted, wanted.replace(/\.md$/, ""));
	return row ?? undefined;
}

interface Report {
	concept: ConceptRow;
	outlinks: EdgeRow[];
	backlinks: EdgeRow[];
	siblings: Array<Omit<ConceptRow, "id">>;
	unresolved: UnresolvedRow[];
}

function reportText(report: Report): string {
	const { concept } = report;
	const lines = [
		concept.title ? `${concept.path} — ${concept.title}` : concept.path,
	];

	section(lines, "Outgoing", report.outlinks, (edge) => [
		`→ ${edge.path}${edge.anchor ? `#${edge.anchor}` : ""}`,
		describe(edge.kind, edge.link_text ?? edge.title),
	]);
	section(lines, "Incoming", report.backlinks, (edge) => [
		`← ${edge.path}`,
		describe(edge.kind, edge.link_text ?? edge.title),
	]);
	section(lines, "Siblings", report.siblings, (sibling) => [
		`· ${sibling.path}`,
		sibling.title ?? "",
	]);
	section(lines, "Unresolved", report.unresolved, (link) => [
		`? ${link.target_path}${link.anchor ? `#${link.anchor}` : ""}`,
		describe(link.kind, link.link_text),
	]);

	return `${lines.join("\n")}\n`;
}

/** A heading with its count, then one aligned line per entry. */
function section<Entry>(
	lines: string[],
	title: string,
	entries: Entry[],
	format: (entry: Entry) => [string, string],
): void {
	lines.push("", `${title} (${entries.length}):`);
	if (entries.length === 0) {
		lines.push("  none");
		return;
	}

	const formatted = entries.map(format);
	const width = Math.max(...formatted.map(([left]) => left.length));
	for (const [left, right] of formatted) {
		lines.push(`  ${right === "" ? left : `${left.padEnd(width)}  ${right}`}`);
	}
}

/** How an edge was authored: a citation says so, a body link quotes its text. */
function describe(kind: string, text: string | null): string {
	if (kind === "source") {
		return text ? `cited as "${text}"` : "cited";
	}
	return text ? `"${text}"` : "";
}
