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
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import matter from "gray-matter";
import { isExternal } from "../sync/links.js";
import { currentState } from "./read.js";
import { rewriteLinks, writeTarget } from "./relink.js";
import { directoryOf } from "./store.js";

/** The first line inside an exported file's frontmatter. */
export const EXPORT_MARK =
	"# An export of a Lattice note. Lattice never reads this file back: change the note through Lattice's tools.";

/**
 * Written at the top of an export folder, listing the files it holds. It is
 * how a later export knows the folder is its own (and may be refreshed) and
 * which files have gone stale: a note renamed or archived since.
 */
export const EXPORT_MANIFEST = ".lattice-export";

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
	const previous = previousFiles(dir);

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
			"SELECT id, version FROM concepts WHERE archived = 0 ORDER BY identifier",
		)
		.all();
	let bytes = 0;
	const written: string[] = [];
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
		written.push(`${state.name}.md`);
	}

	// A note renamed or archived since the last export has no file now.
	for (const old of previous.filter((file) => !written.includes(file))) {
		rmSync(join(dir, old), { force: true });
		for (
			let up = dirname(join(dir, old));
			up.length > dir.length;
			up = dirname(up)
		) {
			try {
				rmdirSync(up);
			} catch {
				break;
			}
		}
	}
	writeFileSync(
		join(dir, EXPORT_MANIFEST),
		`${JSON.stringify({ note: "An export of the Lattice note store. Lattice never reads it back.", exported_at: now.toISOString(), files: written }, null, 2)}\n`,
	);
	return { dir, notes: rows.length, bytes };
}

/**
 * The files a previous export left in `dir`. A folder that holds anything but
 * an export is refused: writing over someone's files is not what a copy is for.
 */
function previousFiles(dir: string): string[] {
	if (!existsSync(dir) || readdirSync(dir).length === 0) {
		return [];
	}
	const manifest = join(dir, EXPORT_MANIFEST);
	if (!existsSync(manifest)) {
		throw new Error(
			`${dir} is not empty and is not a previous export, so nothing was written. Name a new or empty folder.`,
		);
	}
	try {
		const listed = (
			JSON.parse(readFileSync(manifest, "utf8")) as { files?: unknown }
		).files;
		return Array.isArray(listed)
			? listed.filter(
					(file): file is string =>
						typeof file === "string" && !file.includes(".."),
				)
			: [];
	} catch {
		return [];
	}
}

/** A citation as the path it names from the root, for looking it up among renamed notes. */
function relativeTo(source: string, dir: string): string {
	if (isExternal(source)) {
		return source;
	}
	return source.startsWith("/")
		? posix.normalize(source.slice(1))
		: posix.normalize(posix.join(dir, source));
}
