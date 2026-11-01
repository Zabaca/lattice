/**
 * Reading the note store: one note, a list, a note's links, its history.
 *
 * Every function answers with plain data in the shape a tool returns it, or a
 * `Refusal` that says what happened and what to do next.
 */

import type { Database } from "bun:sqlite";
import type { Trust } from "./store.js";

/** A refusal: what went wrong, and the next thing to try. */
export interface Refusal {
	refused: string;
	next: string;
}

export function isRefusal(value: unknown): value is Refusal {
	return (
		typeof value === "object" &&
		value !== null &&
		"refused" in value &&
		"next" in value
	);
}

/** The words a section's trust is shown in. */
export type Checked = "unchecked" | "agent" | "james";

export function checkedLabel(trust: Trust): Checked {
	return trust === "human-reviewed"
		? "james"
		: trust === "machine-confirmed"
			? "agent"
			: "unchecked";
}

/** A note's name resolved to the note, following an old name after a rename. */
export interface Resolved {
	id: number;
	name: string;
	/** The name that was asked for, when it was an old one. */
	oldName?: string;
}

/**
 * The note a name refers to. A name may be given with a `.md` suffix or a
 * leading slash, the way a link writes it; an old name after a rename leads to
 * the note it was.
 */
export function resolveNote(db: Database, asked: string): Resolved | Refusal {
	const name = asked.trim().replace(/^\/+/, "").replace(/\.md$/, "");
	const direct = db
		.query<{ id: number; identifier: string }, [string]>(
			"SELECT id, identifier FROM concepts WHERE identifier = ?",
		)
		.get(name);
	if (direct !== null) {
		return { id: direct.id, name: direct.identifier };
	}

	const old = db
		.query<{ id: number; identifier: string }, [string]>(
			`SELECT c.id, c.identifier FROM note_names n
			JOIN concepts c ON c.id = n.concept_id WHERE n.name = ?`,
		)
		.get(name);
	if (old !== null) {
		return { id: old.id, name: old.identifier, oldName: name };
	}

	const last = name.split("/").pop() ?? name;
	const near = db
		.query<{ identifier: string }, [string]>(
			`SELECT identifier FROM concepts WHERE identifier LIKE ?
			ORDER BY identifier LIMIT 5`,
		)
		.all(`%${last.replace(/[%_]/g, "")}%`)
		.map((row) => row.identifier);
	return {
		refused: `There is no note named ${name}.`,
		next:
			near.length > 0
				? `Did you mean ${near.join(", ")}? Otherwise use recall to find it, or list_notes to browse.`
				: "Use recall to find it by what it says, or list_notes to browse.",
	};
}

export interface OutlineEntry {
	id: string;
	heading: string | null;
	depth: number;
	chars: number;
	checked: Checked;
	version: number;
}

/** A section as read, in whichever version was asked for. */
export interface SectionState {
	sid: string;
	depth: number;
	heading: string | null;
	text: string;
	version: number;
	trust: Trust;
}

export interface NoteState {
	name: string;
	type: string;
	title: string | null;
	description: string | null;
	status: string | null;
	staleAfter: string | null;
	tags: string[];
	sources: unknown[];
	extra: Record<string, unknown>;
	archived: boolean;
	sections: SectionState[];
}

/** The most text `read_note` returns without being asked for sections by id. */
export const WHOLE_NOTE_CHARS = 8000;

export interface NoteRead {
	name: string;
	/** The name asked for, when it was an old one. */
	answers_to?: string;
	title: string | null;
	type: string;
	description: string | null;
	status: string | null;
	stale_after: string | null;
	tags: string[];
	sources: unknown[];
	fields?: Record<string, unknown>;
	version: number;
	/** Set when an earlier version was asked for. */
	as_of_version?: number;
	archived?: true;
	old?: true;
	full_text_lost?: true;
	stale?: true;
	sections: number;
	checked: number;
	outline: OutlineEntry[];
	text: Array<{ id: string; text: string }>;
	hint?: string;
}

export function readNote(
	db: Database,
	asked: string,
	options: { sections?: string[]; version?: number; now?: number } = {},
): NoteRead | Refusal {
	const found = resolveNote(db, asked);
	if (isRefusal(found)) {
		return found;
	}

	const current = db
		.query<{ version: number }, [number]>(
			"SELECT version FROM concepts WHERE id = ?",
		)
		.get(found.id)?.version;
	if (current === undefined) {
		return { refused: `Note ${found.name} vanished.`, next: "Try again." };
	}

	let state = currentState(db, found.id);
	let version = current;
	if (options.version !== undefined && options.version !== current) {
		if (
			!Number.isInteger(options.version) ||
			options.version < 1 ||
			options.version > current
		) {
			return {
				refused: `${found.name} has no version ${options.version}; its versions run from 1 to ${current}.`,
				next: "Use history with the note's name to see its versions.",
			};
		}
		state = rewind(db, found.id, state, options.version);
		version = options.version;
	}

	const outline = state.sections.map(
		(section): OutlineEntry => ({
			id: section.sid,
			heading: section.heading,
			depth: section.depth,
			chars: section.text.length,
			checked: checkedLabel(section.trust),
			version: section.version,
		}),
	);

	const wanted = options.sections;
	let shown: SectionState[];
	let hint: string | undefined;
	if (wanted !== undefined && wanted.length > 0) {
		const missing = wanted.filter(
			(sid) => !state.sections.some((section) => section.sid === sid),
		);
		if (missing.length > 0) {
			return {
				refused: `${found.name} has no section ${missing.join(", ")}.`,
				next: `Its sections are ${state.sections.map((section) => section.sid).join(", ")}.`,
			};
		}
		shown = wanted.map((sid) => {
			const section = state.sections.find((entry) => entry.sid === sid);
			if (section === undefined) {
				throw new Error(`Section ${sid} vanished`);
			}
			return section;
		});
	} else {
		const total = state.sections.reduce((sum, s) => sum + s.text.length, 0);
		if (total <= WHOLE_NOTE_CHARS) {
			shown = state.sections;
		} else {
			shown = state.sections.slice(0, 1);
			hint = `This note is ${total} characters, over ${WHOLE_NOTE_CHARS}. Only its first section is shown: ask for others with sections: ["s2", ...] using the outline.`;
		}
	}

	const tags = state.tags;
	const stale = isPast(state.staleAfter, options.now ?? Date.now());
	const old = tags.includes("old");
	const read: NoteRead = {
		name: found.name,
		title: state.title,
		type: state.type,
		description: state.description,
		status: state.status,
		stale_after: state.staleAfter,
		tags,
		sources: state.sources,
		version,
		sections: outline.length,
		checked: outline.filter((entry) => entry.checked !== "unchecked").length,
		outline,
		text: shown.map((section) => ({ id: section.sid, text: section.text })),
	};
	if (found.oldName !== undefined) {
		read.answers_to = found.oldName;
	}
	if (Object.keys(state.extra).length > 0) {
		read.fields = state.extra;
	}
	if (options.version !== undefined && options.version !== current) {
		read.as_of_version = options.version;
	}
	if (state.archived) {
		read.archived = true;
	}
	if (old) {
		read.old = true;
	}
	if (tags.includes("full-text-lost")) {
		read.full_text_lost = true;
	}
	if (stale && !old) {
		read.stale = true;
	}
	if (hint !== undefined) {
		read.hint = hint;
	}
	return read;
}

function isPast(date: string | null, now: number): boolean {
	if (date === null) {
		return false;
	}
	const at = Date.parse(date);
	return !Number.isNaN(at) && at < now;
}

/** The note as it stands now. */
export function currentState(db: Database, conceptId: number): NoteState {
	const row = db
		.query<
			{
				identifier: string;
				type: string;
				title: string | null;
				description: string | null;
				status: string | null;
				stale_after: string | null;
				sources: string;
				frontmatter: string | null;
				archived: number;
			},
			[number]
		>(
			`SELECT identifier, type, title, description, status, stale_after, sources,
				frontmatter, archived FROM concepts WHERE id = ?`,
		)
		.get(conceptId);
	if (row === null) {
		throw new Error(`No note with id ${conceptId}`);
	}
	return {
		name: row.identifier,
		type: row.type,
		title: row.title,
		description: row.description,
		status: row.status,
		staleAfter: row.stale_after,
		tags: db
			.query<{ tag: string }, [number]>(
				"SELECT tag FROM tags WHERE concept_id = ? ORDER BY rowid",
			)
			.all(conceptId)
			.map((entry) => entry.tag),
		sources: JSON.parse(row.sources) as unknown[],
		extra: JSON.parse(row.frontmatter ?? "{}") as Record<string, unknown>,
		archived: row.archived === 1,
		sections: db
			.query<SectionState, [number]>(
				`SELECT sid, depth, heading, text, version, trust
				FROM sections WHERE concept_id = ? ORDER BY position`,
			)
			.all(conceptId),
	};
}

interface ChangedSection {
	sid: string;
	op: string;
	before_text: string | null;
	before_heading: string | null;
	before_depth: number | null;
	before_version: number | null;
	before_trust: Trust | null;
}

/**
 * The note as it stood at an earlier version: the present state with every
 * later change taken back, newest first. A change records what each section
 * was before it (text, heading, depth, version, checked mark) and the order the
 * sections stood in when it altered that, so taking it back is putting that
 * back, and the result is exact.
 */
export function rewind(
	db: Database,
	conceptId: number,
	now: NoteState,
	target: number,
): NoteState {
	const state: NoteState = {
		...now,
		tags: [...now.tags],
		extra: { ...now.extra },
		sections: now.sections.map((section) => ({ ...section })),
	};

	const changes = db
		.query<{ id: number; order_before: string | null }, [number, number]>(
			`SELECT id, order_before FROM changes
			WHERE concept_id = ? AND version > ? ORDER BY version DESC`,
		)
		.all(conceptId, target);

	for (const change of changes) {
		const sections = db
			.query<ChangedSection, [number]>(
				`SELECT sid, op, before_text, before_heading, before_depth,
					before_version, before_trust
				FROM change_sections WHERE change_id = ?`,
			)
			.all(change.id);
		for (const entry of sections) {
			putBack(state.sections, entry);
		}
		if (change.order_before !== null) {
			putInOrder(state.sections, JSON.parse(change.order_before) as string[]);
		}

		for (const field of db
			.query<{ field: string; before: string | null }, [number]>(
				"SELECT field, before FROM change_fields WHERE change_id = ?",
			)
			.all(change.id)) {
			const before: unknown =
				field.before === null ? null : JSON.parse(field.before);
			setField(state, field.field, before);
		}
	}
	return state;
}

/** Undo one section's part of a change, apart from where it stood. */
function putBack(sections: SectionState[], entry: ChangedSection): void {
	const at = sections.findIndex((section) => section.sid === entry.sid);

	if (entry.op === "insert") {
		if (at !== -1) {
			sections.splice(at, 1);
		}
		return;
	}
	if (entry.op === "remove") {
		sections.push({
			sid: entry.sid,
			depth: entry.before_depth ?? 0,
			heading: entry.before_heading,
			text: entry.before_text ?? "",
			version: entry.before_version ?? 1,
			trust: entry.before_trust ?? "unverified",
		});
		return;
	}
	if (at === -1) {
		return;
	}

	const section = sections[at];
	if (entry.before_text !== null) {
		section.text = entry.before_text;
		section.heading = entry.before_heading;
		section.depth = entry.before_depth ?? section.depth;
		section.version = entry.before_version ?? section.version;
	}
	if (entry.before_trust !== null) {
		section.trust = entry.before_trust;
	}
}

/** Put the sections in the order a change recorded, leaving none out. */
function putInOrder(sections: SectionState[], order: string[]): void {
	const rank = new Map(order.map((sid, index) => [sid, index]));
	sections.sort(
		(a, b) =>
			(rank.get(a.sid) ?? order.length) - (rank.get(b.sid) ?? order.length),
	);
}

function setField(state: NoteState, field: string, value: unknown): void {
	switch (field) {
		case "name":
			state.name = String(value);
			break;
		case "type":
			state.type = String(value);
			break;
		case "title":
			state.title = value as string | null;
			break;
		case "description":
			state.description = value as string | null;
			break;
		case "status":
			state.status = value as string | null;
			break;
		case "stale_after":
			state.staleAfter = value as string | null;
			break;
		case "tags":
			state.tags = value as string[];
			break;
		case "sources":
			state.sources = value as unknown[];
			break;
		case "archived":
			state.archived = value === true;
			break;
		default:
			if (field.startsWith("fields.")) {
				const key = field.slice("fields.".length);
				if (value === null || value === undefined) {
					delete state.extra[key];
				} else {
					state.extra[key] = value;
				}
			}
	}
}

export interface ListInput {
	type?: string;
	tag?: string;
	includeArchived?: boolean;
	limit?: number;
	offset?: number;
}

export interface ListedNote {
	name: string;
	title: string | null;
	about: string;
	version: number;
	changed: string | null;
	old?: true;
	full_text_lost?: true;
	archived?: true;
}

export function listNotes(
	db: Database,
	input: ListInput,
): { total: number; notes: ListedNote[]; next_offset?: number } {
	const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
	const offset = Math.max(input.offset ?? 0, 0);

	const clauses: string[] = [];
	const values: string[] = [];
	if (input.type !== undefined) {
		clauses.push("c.type = ?");
		values.push(input.type);
	}
	if (input.tag !== undefined) {
		clauses.push(
			"EXISTS (SELECT 1 FROM tags t WHERE t.concept_id = c.id AND t.tag = ?)",
		);
		values.push(input.tag);
	}
	if (input.includeArchived !== true) {
		clauses.push("c.archived = 0");
	}
	const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;

	const total =
		db
			.query<{ n: number }, string[]>(
				`SELECT count(*) AS n FROM concepts c ${where}`,
			)
			.get(...values)?.n ?? 0;

	const rows = db
		.query<
			{
				id: number;
				identifier: string;
				title: string | null;
				description: string | null;
				version: number;
				updated_at: string | null;
				archived: number;
			},
			(string | number)[]
		>(
			`SELECT c.id, c.identifier, c.title, c.description, c.version, c.updated_at, c.archived
			FROM concepts c ${where} ORDER BY c.identifier LIMIT ? OFFSET ?`,
		)
		.all(...values, limit, offset);

	const tagsOf = db.query<{ tag: string }, [number]>(
		"SELECT tag FROM tags WHERE concept_id = ?",
	);
	const notes = rows.map((row): ListedNote => {
		const tags = tagsOf.all(row.id).map((entry) => entry.tag);
		const listed: ListedNote = {
			name: row.identifier,
			title: row.title,
			about: firstLine(row.description),
			version: row.version,
			changed: row.updated_at?.slice(0, 10) ?? null,
		};
		if (tags.includes("old")) {
			listed.old = true;
		}
		if (tags.includes("full-text-lost")) {
			listed.full_text_lost = true;
		}
		if (row.archived === 1) {
			listed.archived = true;
		}
		return listed;
	});

	return {
		total,
		notes,
		...(offset + limit < total ? { next_offset: offset + limit } : {}),
	};
}

/** The first line of a description, kept short. */
export function firstLine(text: string | null): string {
	if (text === null) {
		return "";
	}
	const line = text.split("\n", 1)[0].trim();
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export interface NoteLinks {
	name: string;
	out: Array<{
		to: string;
		title: string | null;
		kind: string;
		text?: string;
	}>;
	in: Array<{
		from: string;
		title: string | null;
		kind: string;
		sentence?: string;
	}>;
	unwritten: Array<{ target: string; text?: string; sentence?: string }>;
}

export function noteLinks(db: Database, asked: string): NoteLinks | Refusal {
	const found = resolveNote(db, asked);
	if (isRefusal(found)) {
		return found;
	}

	const out = db
		.query<
			{
				identifier: string;
				title: string | null;
				kind: string;
				link_text: string | null;
			},
			[number]
		>(
			`SELECT far.identifier, far.title, l.kind, l.link_text
			FROM links l JOIN concepts far ON far.id = l.target_concept_id
			WHERE l.source_concept_id = ? ORDER BY l.id`,
		)
		.all(found.id)
		.map((row) => ({
			to: row.identifier,
			title: row.title,
			kind: row.kind,
			...(row.link_text === null ? {} : { text: row.link_text }),
		}));

	const incoming = db
		.query<
			{
				identifier: string;
				title: string | null;
				kind: string;
				context: string | null;
			},
			[number]
		>(
			`SELECT far.identifier, far.title, l.kind, l.context
			FROM links l JOIN concepts far ON far.id = l.source_concept_id
			WHERE l.target_concept_id = ? ORDER BY far.identifier, l.id`,
		)
		.all(found.id)
		.map((row) => ({
			from: row.identifier,
			title: row.title,
			kind: row.kind,
			...(row.context === null ? {} : { sentence: row.context }),
		}));

	const unwritten = db
		.query<
			{ target_path: string; link_text: string | null; context: string | null },
			[number]
		>(
			`SELECT target_path, link_text, context FROM links
			WHERE source_concept_id = ? AND target_concept_id IS NULL ORDER BY id`,
		)
		.all(found.id)
		.map((row) => ({
			target: (row.target_path ?? "").replace(/\.md$/, ""),
			...(row.link_text === null ? {} : { text: row.link_text }),
			...(row.context === null ? {} : { sentence: row.context }),
		}));

	return { name: found.name, out, in: incoming, unwritten };
}

export interface HistoryInput {
	note?: string;
	who?: string;
	since?: string;
	change?: number;
	limit?: number;
}

export interface ChangeLine {
	change: number;
	note: string;
	version: number;
	at: string;
	who: { client?: string; project?: string; by?: string };
	kind: string;
	reason?: string;
	undone?: true;
	undoes?: number;
}

export interface ChangeDetail extends ChangeLine {
	sections: Array<{
		id: string;
		op: string;
		heading?: string | null;
		before?: string;
		after?: string;
	}>;
	fields: Array<{ field: string; before: unknown; after: unknown }>;
}

interface ChangeRow {
	id: number;
	identifier: string;
	version: number;
	at: string;
	kind: string;
	reason: string | null;
	client: string | null;
	project: string | null;
	by_name: string | null;
	undoes: number | null;
}

const CHANGE_COLUMNS = `ch.id, c.identifier, ch.version, ch.at, ch.kind, ch.reason,
	ch.client, ch.project, ch.by_name, ch.undoes`;

/**
 * Whether a change stands undone: some change undid it, and that one has not
 * itself been undone (undoing an undo brings the first change back).
 */
export function isUndone(db: Database, changeId: number): boolean {
	return db
		.query<{ id: number }, [number]>(
			"SELECT id FROM changes WHERE undoes = ? ORDER BY id",
		)
		.all(changeId)
		.some((undo) => !isUndone(db, undo.id));
}

function changeLine(db: Database, row: ChangeRow): ChangeLine {
	return {
		change: row.id,
		note: row.identifier,
		version: row.version,
		at: row.at,
		who: {
			...(row.client === null ? {} : { client: row.client }),
			...(row.project === null ? {} : { project: row.project }),
			...(row.by_name === null ? {} : { by: row.by_name }),
		},
		kind: row.kind,
		...(row.reason === null ? {} : { reason: row.reason }),
		...(isUndone(db, row.id) ? { undone: true as const } : {}),
		...(row.undoes === null ? {} : { undoes: row.undoes }),
	};
}

export function history(
	db: Database,
	input: HistoryInput,
): { changes: ChangeLine[] } | ChangeDetail | Refusal {
	if (input.change !== undefined) {
		const row = db
			.query<ChangeRow, [number]>(
				`SELECT ${CHANGE_COLUMNS} FROM changes ch
				JOIN concepts c ON c.id = ch.concept_id WHERE ch.id = ?`,
			)
			.get(input.change);
		if (row === null) {
			return {
				refused: `There is no change ${input.change}.`,
				next: "Use history without a change id to list changes and their ids.",
			};
		}
		const sections = db
			.query<
				{
					sid: string;
					op: string;
					before_text: string | null;
					after_text: string | null;
					before_heading: string | null;
					after_heading: string | null;
				},
				[number]
			>(
				`SELECT sid, op, before_text, after_text, before_heading, after_heading
				FROM change_sections WHERE change_id = ? ORDER BY rowid`,
			)
			.all(row.id)
			.map((entry) => ({
				id: entry.sid,
				op: entry.op,
				...(entry.after_heading !== null || entry.before_heading !== null
					? { heading: entry.after_heading ?? entry.before_heading }
					: {}),
				...(entry.before_text === null ? {} : { before: entry.before_text }),
				...(entry.after_text === null ? {} : { after: entry.after_text }),
			}));
		const fields = db
			.query<
				{ field: string; before: string | null; after: string | null },
				[number]
			>(
				"SELECT field, before, after FROM change_fields WHERE change_id = ? ORDER BY rowid",
			)
			.all(row.id)
			.map((entry) => ({
				field: entry.field,
				before:
					entry.before === null ? null : (JSON.parse(entry.before) as unknown),
				after:
					entry.after === null ? null : (JSON.parse(entry.after) as unknown),
			}));
		return { ...changeLine(db, row), sections, fields };
	}

	const clauses: string[] = [];
	const values: (string | number)[] = [];
	if (input.note !== undefined) {
		const found = resolveNote(db, input.note);
		if (isRefusal(found)) {
			return found;
		}
		clauses.push("ch.concept_id = ?");
		values.push(found.id);
	}
	if (input.who !== undefined) {
		clauses.push(
			"(ch.client LIKE ? OR ch.by_name LIKE ? OR ch.project LIKE ?)",
		);
		const like = `%${input.who}%`;
		values.push(like, like, like);
	}
	if (input.since !== undefined) {
		if (Number.isNaN(Date.parse(input.since))) {
			return {
				refused: `"${input.since}" is not a date.`,
				next: "Give since as a date such as 2026-11-01.",
			};
		}
		clauses.push("ch.at >= ?");
		values.push(new Date(input.since).toISOString());
	}
	const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
	const rows = db
		.query<ChangeRow, (string | number)[]>(
			`SELECT ${CHANGE_COLUMNS} FROM changes ch
			JOIN concepts c ON c.id = ch.concept_id
			${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
			ORDER BY ch.at DESC, ch.id DESC LIMIT ?`,
		)
		.all(...values, limit);
	return { changes: rows.map((row) => changeLine(db, row)) };
}
