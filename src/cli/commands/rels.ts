import type { Database } from "bun:sqlite";
import { resolvePaths } from "../../utils/paths.js";
import { openNoteStore, storeProblem } from "../database.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * What one note is connected to: the notes it links to, the notes linking back
 * at it, and the links it makes that nothing answers yet.
 *
 * The unresolved list is the point of the last of those: it is the store
 * telling its authors which notes they have promised and not written.
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

	const problem = storeProblem(paths);
	if (problem !== undefined) {
		return { code: 1, stderr: problem };
	}

	const wanted = context.positionals[0];
	const db = openNoteStore(paths);
	try {
		const concept = findConcept(db, wanted);
		if (concept === undefined) {
			return {
				code: 1,
				stderr: `No note matches ${wanted}. Check the name; \`lattice sql "SELECT identifier FROM concepts"\` lists them.`,
			};
		}

		const relations = relationsFor(db, concept.id);
		const report = { concept, ...relations };
		if (context.flags.json) {
			return { code: 0, stdout: `${JSON.stringify(report, null, 2)}\n` };
		}
		return { code: 0, stdout: reportText(report) };
	} finally {
		db.close();
	}
}

/**
 * The concept the user named, by path or by OKF identifier. `note/cooling`
 * and `note/cooling.md` are the same document, and either is a reasonable
 * thing to have copied from somewhere else.
 */
function findConcept(db: Database, wanted: string): ConceptRow | undefined {
	const row = db
		.query<ConceptRow, [string, string]>(
			"SELECT id, path, identifier, title FROM concepts WHERE path = ? OR identifier = ?",
		)
		.get(wanted, wanted.replace(/\.md$/, ""));
	return row ?? undefined;
}

interface Relations {
	outlinks: EdgeRow[];
	backlinks: EdgeRow[];
	unresolved: UnresolvedRow[];
}

/** The three relations of one indexed concept, each in authoring order. */
function relationsFor(db: Database, conceptId: number): Relations {
	const outlinks = db
		.query<EdgeRow, [number]>(
			`SELECT ${EDGE_COLUMNS} FROM links l
			JOIN concepts far ON far.id = l.target_concept_id
			WHERE l.source_concept_id = ? ORDER BY l.id`,
		)
		.all(conceptId);

	const backlinks = db
		.query<EdgeRow, [number]>(
			`SELECT ${EDGE_COLUMNS} FROM links l
			JOIN concepts far ON far.id = l.source_concept_id
			WHERE l.target_concept_id = ? ORDER BY far.path, l.id`,
		)
		.all(conceptId);

	const unresolved = db
		.query<UnresolvedRow, [number]>(
			`SELECT l.target_path, l.raw_target, l.kind, l.link_text, l.anchor, l.context
			FROM links l
			WHERE l.source_concept_id = ? AND l.target_concept_id IS NULL
			ORDER BY l.id`,
		)
		.all(conceptId);

	return { outlinks, backlinks, unresolved };
}

interface Report extends Relations {
	concept: ConceptRow;
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
