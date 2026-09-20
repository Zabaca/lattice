import { existsSync } from "node:fs";
import { openDatabase } from "../../db/open.js";
import { resolvePaths } from "../../utils/paths.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * What a concept is connected to: the links it makes, the links made to it,
 * the documents filed beside it, and the links it makes to documents nobody
 * has written yet.
 *
 * Unresolved links are reported rather than hidden, because in OKF they are
 * the shape of the knowledge that is missing.
 */

interface ConceptRow {
	id: number;
	path: string;
	identifier: string;
	dir: string;
	title: string | null;
	type: string | null;
}

interface EdgeRow {
	path: string;
	identifier: string;
	title: string | null;
	kind: string;
	text: string | null;
	anchor: string | null;
	context: string | null;
}

interface UnresolvedRow {
	target_path: string;
	raw_target: string;
	kind: string;
	text: string | null;
	anchor: string | null;
	context: string | null;
}

interface SiblingRow {
	path: string;
	identifier: string;
	title: string | null;
}

export function runRels(context: CommandContext): CommandOutput {
	const paths = resolvePaths(context.env);

	if (!existsSync(paths.database)) {
		return {
			code: 1,
			stderr: `No Lattice index at ${paths.database}. Run \`lattice init\` first.`,
		};
	}

	const name = context.positionals[0];
	const db = openDatabase(paths.database);
	try {
		const matches = findConcepts(db, name);

		if (matches.length === 0) {
			return {
				code: 1,
				stderr: `No concept matches ${name}. Try \`lattice status\` to see what is indexed.`,
			};
		}
		if (matches.length > 1) {
			return {
				code: 1,
				stderr: [
					`${name} matches ${matches.length} concepts:`,
					...matches.map((match) => `  ${match.path}`),
					"Name one of them.",
				].join("\n"),
			};
		}

		const [concept] = matches;
		const report = {
			concept: {
				path: concept.path,
				identifier: concept.identifier,
				title: concept.title,
				type: concept.type,
			},
			outlinks: outlinks(db, concept.id),
			backlinks: backlinks(db, concept.id),
			siblings: siblings(db, concept),
			unresolved: unresolved(db, concept.id),
		};

		return {
			code: 0,
			stdout:
				context.flags.json === undefined
					? reportText(concept, report)
					: `${JSON.stringify(report, null, 2)}\n`,
		};
	} finally {
		db.close();
	}
}

/**
 * The concepts a name could mean: its exact path, its identifier, or its
 * title. Nothing is guessed — an ambiguous name is reported, not resolved.
 */
function findConcepts(
	db: ReturnType<typeof openDatabase>,
	name: string,
): ConceptRow[] {
	return db
		.query<ConceptRow, [string, string, string]>(
			`SELECT id, path, identifier, dir, title, type FROM concepts
			 WHERE path = ? OR identifier = ? OR title = ?
			 ORDER BY path`,
		)
		.all(name, name, name);
}

function outlinks(
	db: ReturnType<typeof openDatabase>,
	conceptId: number,
): EdgeRow[] {
	return db
		.query<EdgeRow, [number]>(
			`SELECT t.path, t.identifier, t.title, l.kind, l.link_text AS text,
			        l.target_anchor AS anchor, l.context
			 FROM links l JOIN concepts t ON t.id = l.target_concept_id
			 WHERE l.source_concept_id = ?
			 ORDER BY t.path, l.id`,
		)
		.all(conceptId);
}

function backlinks(
	db: ReturnType<typeof openDatabase>,
	conceptId: number,
): EdgeRow[] {
	return db
		.query<EdgeRow, [number]>(
			`SELECT s.path, s.identifier, s.title, l.kind, l.link_text AS text,
			        l.target_anchor AS anchor, l.context
			 FROM links l JOIN concepts s ON s.id = l.source_concept_id
			 WHERE l.target_concept_id = ?
			 ORDER BY s.path, l.id`,
		)
		.all(conceptId);
}

function unresolved(
	db: ReturnType<typeof openDatabase>,
	conceptId: number,
): UnresolvedRow[] {
	return db
		.query<UnresolvedRow, [number]>(
			`SELECT l.target_path, l.raw_target, l.kind, l.link_text AS text,
			        l.target_anchor AS anchor, l.context
			 FROM links l
			 WHERE l.source_concept_id = ? AND l.target_concept_id IS NULL
			 ORDER BY l.target_path, l.id`,
		)
		.all(conceptId);
}

/** The other documents in the same directory — OKF's own grouping. */
function siblings(
	db: ReturnType<typeof openDatabase>,
	concept: ConceptRow,
): SiblingRow[] {
	return db
		.query<SiblingRow, [string, number]>(
			`SELECT path, identifier, title FROM concepts
			 WHERE dir = ? AND id <> ?
			 ORDER BY path`,
		)
		.all(concept.dir, concept.id);
}

interface Report {
	outlinks: EdgeRow[];
	backlinks: EdgeRow[];
	siblings: SiblingRow[];
	unresolved: UnresolvedRow[];
}

function reportText(concept: ConceptRow, report: Report): string {
	const lines = [
		concept.title === null
			? concept.path
			: `${concept.path} — ${concept.title}`,
	];

	section(
		lines,
		"Links to",
		report.outlinks,
		(edge) =>
			`${edge.path}${label(edge.title)}  [${edge.kind}]${quoted(edge.text)}${
				edge.anchor === null ? "" : ` #${edge.anchor}`
			}`,
	);
	section(
		lines,
		"Linked from",
		report.backlinks,
		(edge) =>
			`${edge.path}${label(edge.title)}  [${edge.kind}]${quoted(edge.text)}`,
	);
	section(
		lines,
		"Unresolved",
		report.unresolved,
		(edge) =>
			`${edge.target_path}  [${edge.kind}]${quoted(edge.text)}  (written as ${edge.raw_target})`,
	);
	section(
		lines,
		"Siblings",
		report.siblings,
		(sibling) => `${sibling.path}${label(sibling.title)}`,
	);

	return `${lines.join("\n")}\n`;
}

/** One titled group, always shown — an empty group is itself an answer. */
function section<Row>(
	lines: string[],
	title: string,
	rows: Row[],
	format: (row: Row) => string,
): void {
	lines.push("");
	lines.push(`${title} (${rows.length}):`);
	if (rows.length === 0) {
		lines.push("  none");
		return;
	}
	for (const row of rows) {
		lines.push(`  ${format(row)}`);
	}
}

function label(title: string | null): string {
	return title === null ? "" : `  ${title}`;
}

function quoted(text: string | null): string {
	return text === null ? "" : ` "${text}"`;
}
