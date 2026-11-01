/**
 * The writes that are about a note as a whole: making one, its fields, its name,
 * archiving it, and confirming its sections. The shared machinery (snapshots,
 * guards, the commit) is in `write.ts`.
 */

import type { Database } from "bun:sqlite";
import { posix } from "node:path";
import { conceptText } from "../embed/run.js";
import { isExternal } from "../sync/links.js";
import { typeDirectory } from "../sync/okf.js";
import { isRefusal, type Refusal, resolveNote } from "./read.js";
import { moveSource, rewriteLinks, writeTarget } from "./relink.js";
import { splitSections } from "./sections.js";
import {
	createNote,
	directoryOf,
	loadHeld,
	type NoteFields,
	type SectionOp,
	type Trust,
} from "./store.js";
import {
	type Build,
	commit,
	conceptVector,
	newVectors,
	noSection,
	refuse,
	settle,
	staleSection,
	type WriteContext,
	type Written,
	whoOf,
} from "./write.js";

// ---------------------------------------------------------------------------
// create_note

export interface CreateInput {
	type: string;
	title: string;
	description?: string;
	text?: string;
	tags?: string[];
	sources?: string[];
	reason?: string;
	by?: string;
}

/** The note that has `name` now or had it before a rename, if any. */
function holderOf(
	db: Database,
	name: string,
): { name: string; title: string | null } | null {
	const now = db
		.query<{ identifier: string; title: string | null }, [string]>(
			"SELECT identifier, title FROM concepts WHERE identifier = ?",
		)
		.get(name);
	if (now !== null) {
		return { name: now.identifier, title: now.title };
	}
	const before = db
		.query<{ identifier: string; title: string | null }, [string]>(
			`SELECT c.identifier, c.title FROM note_names n
			JOIN concepts c ON c.id = n.concept_id WHERE n.name = ?`,
		)
		.get(name);
	return before === null
		? null
		: { name: before.identifier, title: before.title };
}

/** The name a type and a title make: the type's folder and the title as a slug. */
export function nameOf(type: string, title: string): string | undefined {
	const folder = typeDirectory(type);
	const slug = typeDirectory(title);
	return folder === "" || slug === "" ? undefined : `${folder}/${slug}`;
}

export async function createNewNote(
	ctx: WriteContext,
	input: CreateInput,
): Promise<Written | Refusal> {
	const { db } = ctx;
	const type = input.type.trim();
	const title = input.title.trim();
	const name = nameOf(type, title);
	if (name === undefined) {
		return refuse(
			"A note's name is made from its type and its title, and one of them has no letters or digits.",
			"Give a type such as Research or Topic and a title in words.",
		);
	}
	if (title.includes("\n")) {
		return refuse(
			"A title is one line.",
			"Put the rest in the description or the text.",
		);
	}

	const taken = holderOf(db, name);
	if (taken !== null) {
		return takenRefusal(name, taken);
	}

	const text = input.text?.trim() ?? "";
	const body =
		text === ""
			? `# ${title}\n`
			: /^#\s/.test(text)
				? `${text}\n`
				: `# ${title}\n\n${text}\n`;
	const dir = directoryOf(`${name}.md`);
	const fields: NoteFields = {
		type,
		title,
		description: blankToNull(input.description),
		status: "draft",
		staleAfter: null,
		tags: unique(input.tags ?? []),
		sources: unique(
			(input.sources ?? []).map((source) => sourceEntry(db, source, dir)),
		),
		extra: {},
	};

	// The vectors are made before the transaction opens; the name is checked
	// inside it, so two sessions making the same note cannot both succeed.
	const vectors = await newVectors(ctx, new Map(), body);
	const noteText = conceptText(title, fields.description, fields.tags);
	const noteVector = await conceptVector(ctx, noteText, new Map());
	const made = db
		.transaction(() => {
			const holder = holderOf(db, name);
			if (holder !== null) {
				return holder;
			}
			return createNote(
				db,
				{ name, fields, sections: splitSections(body) },
				{
					kind: "create",
					reason: input.reason,
					who: whoOf(ctx, input.by),
					at: ctx.now?.(),
					carry: vectors.carry,
					conceptVectors: noteVector.vectors,
				},
			);
		})
		.immediate();
	if (!("changeId" in made)) {
		return takenRefusal(name, made);
	}
	const problems = await settle(
		ctx,
		made.conceptId,
		vectors.failed,
		[vectors.note, noteVector.note],
		noteVector.failed,
	);
	return {
		note: name,
		version: made.version,
		change: made.changeId,
		sections: loadHeld(db, made.conceptId).map((section) => ({
			id: section.sid,
			version: section.version,
		})),
		...(problems === undefined ? {} : { search: problems }),
	};
}

function takenRefusal(
	name: string,
	holder: { name: string; title: string | null },
): Refusal {
	return refuse(
		holder.name === name
			? `A note named ${name} already exists (${holder.title ?? "untitled"}).`
			: `${name} is an old name of ${holder.name}.`,
		`Extend it instead: read_note ${holder.name}, then edit or append. For a different note, use a different title.`,
	);
}

function blankToNull(value: string | undefined | null): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	return value.trim() === "" ? null : value.trim();
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

/**
 * A citation as the note stores it: an outside page as it was given, a note by
 * its name written as the relative path other notes use for it.
 */
export function sourceEntry(db: Database, source: string, dir: string): string {
	const value = source.trim();
	if (isExternal(value)) {
		return value;
	}
	const found = resolveNote(db, value);
	if (isRefusal(found)) {
		return value;
	}
	return posix.relative(dir === "" ? "." : dir, `${found.name}.md`);
}

// ---------------------------------------------------------------------------
// fields

export interface SetFieldsInput {
	note: string;
	/** The note version the caller read; the change is refused if the note moved on. */
	version?: number;
	title?: string | null;
	description?: string | null;
	status?: string | null;
	stale_after?: string | null;
	tags?: string[];
	add_tags?: string[];
	remove_tags?: string[];
	add_sources?: string[];
	remove_sources?: string[];
	reason?: string;
	by?: string;
}

export async function setFields(
	ctx: WriteContext,
	input: SetFieldsInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	if (input.stale_after !== undefined && input.stale_after !== null) {
		if (
			input.stale_after.trim() !== "" &&
			Number.isNaN(Date.parse(input.stale_after))
		) {
			return refuse(
				`"${input.stale_after}" is not a date.`,
				"Give stale_after as a date such as 2027-01-31, or an empty string to clear it.",
			);
		}
	}

	return commit(ctx, found.id, "set_fields", input, (snap) => {
		if (input.version !== undefined && input.version !== snap.concept.version) {
			return refuse(
				`${snap.name} is at version ${snap.concept.version}; you read version ${input.version}. It changed since you read it.`,
				"Read it again (read_note) and repeat the change.",
			);
		}
		const dir = directoryOf(`${snap.name}.md`);
		const next: Partial<NoteFields> = {};
		if (input.title !== undefined) {
			next.title = blankToNull(input.title);
		}
		if (input.description !== undefined) {
			next.description = blankToNull(input.description);
		}
		if (input.status !== undefined) {
			next.status = blankToNull(input.status);
		}
		if (input.stale_after !== undefined) {
			next.staleAfter = blankToNull(input.stale_after);
		}

		let tags = input.tags === undefined ? snap.fields.tags : unique(input.tags);
		tags = unique([...tags, ...(input.add_tags ?? [])]).filter(
			(tag) => !(input.remove_tags ?? []).includes(tag),
		);
		if (JSON.stringify(tags) !== JSON.stringify(snap.fields.tags)) {
			next.tags = tags;
		}

		let sources: NoteFields["sources"] = unique([
			...snap.fields.sources,
			...(input.add_sources ?? []).map((source) =>
				sourceEntry(ctx.db, source, dir),
			),
		]);
		const removed = (input.remove_sources ?? []).map((source) =>
			sourceEntry(ctx.db, source, dir),
		);
		sources = sources.filter(
			(source) => typeof source !== "string" || !removed.includes(source),
		);
		if (JSON.stringify(sources) !== JSON.stringify(snap.fields.sources)) {
			next.sources = sources;
		}

		const changed = (Object.keys(next) as Array<keyof NoteFields>).filter(
			(key) => JSON.stringify(next[key]) !== JSON.stringify(snap.fields[key]),
		);
		if (changed.length === 0) {
			return { ops: [], skip: "The note already has those values." };
		}
		const only: Partial<NoteFields> = {};
		for (const key of changed) {
			(only as Record<string, unknown>)[key] = next[key];
		}
		return { ops: [], fields: only };
	});
}

// ---------------------------------------------------------------------------
// rename, archive

export interface RenameInput {
	note: string;
	title?: string;
	type?: string;
	reason?: string;
	by?: string;
}

export async function renameNote(
	ctx: WriteContext,
	input: RenameInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	if (input.title === undefined && input.type === undefined) {
		return refuse(
			"Nothing to rename to.",
			"Give a new title, a new type, or both.",
		);
	}

	return commit(ctx, found.id, "rename", input, (snap) => {
		const type = input.type?.trim() ?? snap.fields.type;
		const title = input.title?.trim() ?? snap.fields.title ?? "";
		const name = nameOf(type, title);
		if (name === undefined) {
			return refuse(
				"A note's name is made from its type and its title, and one of them has no letters or digits.",
				"Give a type and a title in words.",
			);
		}
		if (title.includes("\n")) {
			return refuse("A title is one line.", "Shorten it.");
		}
		if (
			name === snap.name &&
			type === snap.fields.type &&
			title === snap.fields.title
		) {
			return refuse(
				`${snap.name} already has that type and title.`,
				"Give a different title or type.",
			);
		}
		const holder = holderOf(ctx.db, name);
		if (holder !== null && holder.name !== snap.name) {
			return takenRefusal(name, holder);
		}

		const ops: SectionOp[] = [];
		const fields: Build["fields"] = { type, title };
		const from = directoryOf(`${snap.name}.md`);
		const to = directoryOf(`${name}.md`);
		if (from !== to) {
			// The note's folder changes, so a relative link in it would point
			// somewhere else; write each one so it still reaches the same note.
			for (const section of snap.sections) {
				const text = rewriteLinks(section.text, from, (link) =>
					link.rawTarget.startsWith("/")
						? undefined
						: writeTarget(link.rawTarget, link.targetPath, to, link.anchor),
				);
				if (text !== section.text) {
					ops.push({ op: "update", sid: section.sid, text });
				}
			}
			const sources = snap.fields.sources.map((source) =>
				moveSource(source, from, to),
			);
			if (JSON.stringify(sources) !== JSON.stringify(snap.fields.sources)) {
				fields.sources = sources;
			}
		}
		return {
			ops,
			fields,
			rename: name === snap.name ? undefined : name,
		};
	});
}

export interface ArchiveInput {
	note: string;
	reason?: string;
	by?: string;
}

export async function archiveNote(
	ctx: WriteContext,
	input: ArchiveInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	return commit(ctx, found.id, "archive", input, (snap) => {
		if (snap.concept.archived === 1) {
			return refuse(
				`${snap.name} is already archived.`,
				"To bring it back, undo the change that archived it (history, then revert).",
			);
		}
		return { ops: [], fields: { archived: true } };
	});
}

// ---------------------------------------------------------------------------
// confirm

export interface ConfirmInput {
	note: string;
	/** Each section to mark, with the version the caller read. */
	sections: Array<{ id: string; version: number }>;
	/** What James said, when he confirmed it in this session. */
	james_said?: string;
	reason?: string;
	by?: string;
}

const RANK: Record<Trust, number> = {
	unverified: 0,
	"machine-confirmed": 1,
	"human-reviewed": 2,
};

export async function confirmSections(
	ctx: WriteContext,
	input: ConfirmInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	const james = input.james_said !== undefined;
	if (james && input.james_said?.trim() === "") {
		return refuse(
			"james_said is empty.",
			"Give James's own words, or leave james_said out to confirm as an agent.",
		);
	}
	if (!james && input.by?.trim().toLowerCase() === "james") {
		return refuse(
			"An agent cannot confirm as James.",
			"Leave `by` as your own name, or pass james_said with his words if he confirmed it in this session.",
		);
	}
	if (input.sections.length === 0) {
		return refuse(
			"There are no sections to confirm.",
			"Name each section with the version you read (read_note's outline shows both).",
		);
	}
	const trust: Trust = james ? "human-reviewed" : "machine-confirmed";
	const by = james
		? "james"
		: (input.by ?? ctx.who.by ?? ctx.who.client ?? "agent");
	const at = ctx.now?.() ?? new Date().toISOString();

	return commit(
		ctx,
		found.id,
		"confirm",
		{
			reason: james ? `James said: ${input.james_said?.trim()}` : input.reason,
			by: input.by,
		},
		(snap) => {
			const ids = snap.sections.map((section) => section.sid);
			const missing = input.sections
				.map((wanted) => wanted.id)
				.filter((sid) => !ids.includes(sid));
			if (missing.length > 0) {
				return noSection(snap.name, missing.join(", "), ids.join(", "));
			}
			// What is confirmed is what was read: a section that has been
			// rewritten since is not the text the caller checked.
			for (const wanted of input.sections) {
				const stale = staleSection(snap, wanted.id, wanted.version);
				if (stale !== undefined) {
					return stale;
				}
			}
			const ops: SectionOp[] = [];
			for (const wanted of input.sections) {
				const section = snap.sections.find((s) => s.sid === wanted.id);
				if (section !== undefined && RANK[section.trust] < RANK[trust]) {
					ops.push({ op: "check", sid: wanted.id, trust, by, at });
				}
			}
			if (ops.length === 0) {
				return {
					ops,
					skip: james
						? "Those sections are already checked by James."
						: "Those sections are already checked (an agent's check does not replace James's).",
				};
			}
			return { ops };
		},
	);
}
