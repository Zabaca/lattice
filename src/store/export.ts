/**
 * Writing the store out as markdown.
 *
 * The export is a copy for reading or keeping, never a source: nothing reads
 * it back as notes. Each note becomes one file at its name (its type's folder
 * and its slug), with frontmatter from its fields plus its version, when it was
 * exported and how many of its sections are checked, and a first comment saying
 * what the file is. The body is the sections joined, so it is the note's text
 * exactly, except that a link to a note by a name it no longer has is written
 * with the name it has now.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import matter from "gray-matter";
import { currentState } from "./read.js";
import { rewriteLinks, writeTarget } from "./relink.js";
import { directoryOf } from "./store.js";

/** The first line inside an exported file's frontmatter. */
export const EXPORT_MARK =
	"# An export of a Lattice note. Lattice never reads this file back: change the note through Lattice's tools.";

export interface ExportReport {
	dir: string;
	notes: number;
	bytes: number;
}

export function exportStore(
	db: Database,
	dir: string,
	now: Date = new Date(),
): ExportReport {
	const renamed = new Map(
		db
			.query<{ old: string; path: string }, []>(
				`SELECT n.name || '.md' AS old, c.path FROM note_names n
				JOIN concepts c ON c.id = n.concept_id
				WHERE NOT EXISTS (SELECT 1 FROM concepts x WHERE x.path = n.name || '.md')`,
			)
			.all()
			.map((row) => [row.old, row.path]),
	);

	const rows = db
		.query<{ id: number; version: number }, []>(
			"SELECT id, version FROM concepts ORDER BY identifier",
		)
		.all();
	let bytes = 0;
	for (const row of rows) {
		const state = currentState(db, row.id);
		const where = directoryOf(`${state.name}.md`);
		const body = state.sections
			.map((section) =>
				rewriteLinks(section.text, where, (link) => {
					const now = renamed.get(link.targetPath);
					return now === undefined
						? undefined
						: writeTarget(link.rawTarget, now, where, link.anchor);
				}),
			)
			.join("");

		const sources = state.sources.map((source) =>
			typeof source === "string" && renamed.has(relativeTo(source, where))
				? writeTarget(
						source,
						renamed.get(relativeTo(source, where)) ?? source,
						where,
					)
				: source,
		);
		const data: Record<string, unknown> = {
			type: state.type,
			...(state.title === null ? {} : { title: state.title }),
			...(state.description === null ? {} : { description: state.description }),
			...(state.status === null ? {} : { status: state.status }),
			...(state.staleAfter === null ? {} : { stale_after: state.staleAfter }),
			...(state.tags.length === 0 ? {} : { tags: state.tags }),
			...(sources.length === 0 ? {} : { sources }),
			...state.extra,
			...(state.archived ? { archived: true } : {}),
			version: row.version,
			exported_at: now.toISOString(),
			checked: `${state.sections.filter((s) => s.trust !== "unverified").length} of ${state.sections.length} sections`,
		};

		// gray-matter ends an empty document with a blank line; the body is the
		// note's text exactly, so the frontmatter block stops at its closing rule.
		const front = matter.stringify("", data).replace(/\n$/, "");
		const text = `---\n${EXPORT_MARK}\n${front.slice(front.indexOf("\n") + 1)}${body}`;
		const path = join(dir, `${state.name}.md`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		bytes += Buffer.byteLength(text);
	}
	return { dir, notes: rows.length, bytes };
}

/** A citation as the path it names from the root, for looking it up among renamed notes. */
function relativeTo(source: string, dir: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("//")) {
		return source;
	}
	return source.startsWith("/")
		? posix.normalize(source.slice(1))
		: posix.normalize(posix.join(dir, source));
}
