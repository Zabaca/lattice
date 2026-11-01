/**
 * Writing to the note store: the one place a note changes.
 *
 * Every write is one change, recorded in the transaction that made it: the
 * note and its new version, when, who, what kind, and for every section and
 * field it touched what it was before and what it is now. Nothing else in
 * Lattice writes a note, so no change escapes the history.
 *
 * This is the write primitive. The guards that decide whether a change may
 * land (a quoted passage occurring once, a section version still current) and
 * the tools that build changes from an agent's words sit above it.
 */

import type { Database } from "bun:sqlite";
import { posix } from "node:path";
import { hashContent } from "../sync/scan.js";
import {
	carryFrom,
	refreshDerived,
	resolveLinks,
	type VectorCarry,
} from "./derive.js";
import type { SectionText } from "./sections.js";

export type Trust = "unverified" | "machine-confirmed" | "human-reviewed";

/** Who made a change. All of it is optional: a caller may not know. */
export interface Who {
	/** The MCP client, as its handshake named it: "claude-code 2.1.316". */
	client?: string;
	/** The folder the session runs in. */
	project?: string;
	/** A name the caller gave itself. */
	by?: string;
}

/** What a note says about itself, apart from its text. */
export interface NoteFields {
	type: string;
	title: string | null;
	description: string | null;
	status: string | null;
	staleAfter: string | null;
	tags: string[];
	sources: Array<string | Record<string, unknown>>;
	/** Every other field the note was written with, as written. */
	extra: Record<string, unknown>;
}

export type SectionOp =
	| {
			op: "insert";
			/** The section this one follows; null puts it first. */
			after: string | null;
			depth: number;
			heading: string | null;
			text: string;
	  }
	| {
			op: "update";
			sid: string;
			text: string;
			heading?: string | null;
			depth?: number;
	  }
	| { op: "remove"; sid: string }
	| { op: "move"; sid: string; after: string | null };

export interface ChangeSpec {
	kind: string;
	reason?: string;
	who: Who;
	/** When, as an ISO instant. Defaults to now. */
	at?: string;
	sections?: SectionOp[];
	fields?: Partial<NoteFields> & { archived?: boolean };
	/** Vectors already computed for text this change introduces. */
	carry?: VectorCarry;
	/** Re-point every link afterwards. Off for a bulk load that does it once. */
	resolve?: boolean;
}

export interface NewNote {
	name: string;
	fields: NoteFields;
	sections: SectionText[];
	/** Hidden from recall and listings unless asked for. */
	archived?: boolean;
}

export interface ChangeResult {
	conceptId: number;
	version: number;
	changeId: number;
	chunks: number;
	carried: number;
}

/** A section as held while a change is being worked out. */
interface Held {
	sid: string;
	depth: number;
	heading: string | null;
	text: string;
	version: number;
	trust: Trust;
	checkedBy: string | null;
	checkedAt: string | null;
}

interface SectionRow {
	sid: string;
	depth: number;
	heading: string | null;
	text: string;
	version: number;
	trust: Trust;
	checked_by: string | null;
	checked_at: string | null;
}

interface ConceptRow {
	id: number;
	identifier: string;
	type: string;
	title: string | null;
	description: string | null;
	status: string | null;
	stale_after: string | null;
	sources: string;
	frontmatter: string | null;
	archived: number;
	version: number;
	next_section: number;
}

const TRUST_RANK: Record<Trust, number> = {
	unverified: 0,
	"machine-confirmed": 1,
	"human-reviewed": 2,
};

/**
 * Make a new note: its row, its sections, its first change and its index.
 * The change is version 1.
 */
export function createNote(
	db: Database,
	note: NewNote,
	change: Omit<ChangeSpec, "sections" | "fields">,
): ChangeResult {
	return db.transaction(() => {
		const at = change.at ?? new Date().toISOString();
		const path = `${note.name}.md`;
		const row = db
			.query<{ id: number }, [string, string, string, string, string, string]>(
				`INSERT INTO concepts (
					path, identifier, dir, type, content_hash, created_at, updated_at
				) VALUES (?, ?, ?, ?, '', ?, ?) RETURNING id`,
			)
			.get(path, note.name, directoryOf(path), note.fields.type, at, at);
		if (row === null) {
			throw new Error(`Failed to create ${note.name}`);
		}

		const held: Held[] = [];
		let next = 1;
		const sectionChanges: SectionChange[] = [];
		let previous: string | null = null;
		for (const section of note.sections) {
			const sid = `s${next++}`;
			held.push({
				sid,
				depth: section.depth,
				heading: section.heading,
				text: section.text,
				version: 1,
				trust: "unverified",
				checkedBy: null,
				checkedAt: null,
			});
			sectionChanges.push({
				sid,
				op: "insert",
				afterText: section.text,
				afterHeading: section.heading,
				afterDepth: section.depth,
				afterPrev: previous,
				afterTrust: "unverified",
			});
			previous = sid;
		}

		const empty: NoteFields = {
			type: note.fields.type,
			title: null,
			description: null,
			status: null,
			staleAfter: null,
			tags: [],
			sources: [],
			extra: {},
		};
		return record(db, {
			conceptId: row.id,
			name: note.name,
			version: 1,
			at,
			change,
			held,
			nextSection: next,
			sectionChanges,
			before: empty,
			after: note.fields,
			archived: note.archived ?? false,
			beforeArchived: false,
			carry: change.carry ?? new Map(),
			resolve: change.resolve ?? true,
		});
	})();
}

/** Change a note that exists: its sections, its fields, or both. */
export function changeNote(
	db: Database,
	conceptId: number,
	change: ChangeSpec,
): ChangeResult {
	return db.transaction(() => {
		const at = change.at ?? new Date().toISOString();
		const concept = db
			.query<ConceptRow, [number]>(
				`SELECT id, identifier, type, title, description, status, stale_after,
					sources, frontmatter, archived, version, next_section
				FROM concepts WHERE id = ?`,
			)
			.get(conceptId);
		if (concept === null) {
			throw new Error(`No note with id ${conceptId}`);
		}

		const held = db
			.query<SectionRow, [number]>(
				`SELECT sid, depth, heading, text, version, trust, checked_by, checked_at
				FROM sections WHERE concept_id = ? ORDER BY position`,
			)
			.all(conceptId)
			.map(
				(row): Held => ({
					sid: row.sid,
					depth: row.depth,
					heading: row.heading,
					text: row.text,
					version: row.version,
					trust: row.trust,
					checkedBy: row.checked_by,
					checkedAt: row.checked_at,
				}),
			);

		const before = fieldsOf(db, concept);
		const sectionChanges: SectionChange[] = [];
		let next = concept.next_section;
		const touched = new Set<string>();

		const indexOf = (sid: string): number => {
			const at = held.findIndex((section) => section.sid === sid);
			if (at === -1) {
				throw new Error(`No section ${sid} in ${concept.identifier}`);
			}
			return at;
		};
		const prevOf = (sid: string): string | null => {
			const at = indexOf(sid);
			return at === 0 ? null : held[at - 1].sid;
		};
		const placeAfter = (after: string | null): number =>
			after === null ? 0 : indexOf(after) + 1;

		for (const op of change.sections ?? []) {
			if (op.op === "insert") {
				const sid = `s${next++}`;
				held.splice(placeAfter(op.after), 0, {
					sid,
					depth: op.depth,
					heading: op.heading,
					text: op.text,
					version: 1,
					trust: "unverified",
					checkedBy: null,
					checkedAt: null,
				});
				sectionChanges.push({
					sid,
					op: "insert",
					afterText: op.text,
					afterHeading: op.heading,
					afterDepth: op.depth,
					afterPrev: prevOf(sid),
					afterTrust: "unverified",
				});
				touched.add(sid);
			} else if (op.op === "update") {
				const section = held[indexOf(op.sid)];
				sectionChanges.push({
					sid: op.sid,
					op: "update",
					beforeText: section.text,
					afterText: op.text,
					beforeHeading: section.heading,
					afterHeading: op.heading === undefined ? section.heading : op.heading,
					beforeDepth: section.depth,
					afterDepth: op.depth ?? section.depth,
					beforeTrust: section.trust,
					afterTrust: "unverified",
				});
				section.text = op.text;
				if (op.heading !== undefined) {
					section.heading = op.heading;
				}
				if (op.depth !== undefined) {
					section.depth = op.depth;
				}
				touched.add(op.sid);
			} else if (op.op === "remove") {
				const at = indexOf(op.sid);
				const section = held[at];
				sectionChanges.push({
					sid: op.sid,
					op: "remove",
					beforeText: section.text,
					beforeHeading: section.heading,
					beforeDepth: section.depth,
					beforePrev: prevOf(op.sid),
					beforeTrust: section.trust,
				});
				held.splice(at, 1);
				touched.delete(op.sid);
			} else {
				const section = held[indexOf(op.sid)];
				const beforePrev = prevOf(op.sid);
				held.splice(indexOf(op.sid), 1);
				held.splice(placeAfter(op.after), 0, section);
				sectionChanges.push({
					sid: op.sid,
					op: "move",
					beforePrev,
					afterPrev: prevOf(op.sid),
				});
			}
		}

		for (const section of held) {
			if (touched.has(section.sid)) {
				const wasInserted = sectionChanges.some(
					(entry) => entry.sid === section.sid && entry.op === "insert",
				);
				if (!wasInserted) {
					section.version += 1;
				}
				section.trust = "unverified";
				section.checkedBy = null;
				section.checkedAt = null;
			}
		}

		const after: NoteFields = { ...before, ...stripArchived(change.fields) };
		const carry = carryFrom(db, conceptId);
		for (const [key, vectors] of change.carry ?? []) {
			carry.set(key, vectors);
		}

		return record(db, {
			conceptId,
			name: concept.identifier,
			version: concept.version + 1,
			at,
			change,
			held,
			nextSection: next,
			sectionChanges,
			before,
			after,
			archived: change.fields?.archived ?? concept.archived === 1,
			beforeArchived: concept.archived === 1,
			carry,
			resolve: change.resolve ?? false,
		});
	})();
}

function stripArchived(
	fields: ChangeSpec["fields"],
): Partial<NoteFields> | undefined {
	if (fields === undefined) {
		return undefined;
	}
	const { archived: _archived, ...rest } = fields;
	return rest;
}

/** One section's part of a change, as it is recorded. */
interface SectionChange {
	sid: string;
	op: "insert" | "update" | "remove" | "move" | "check";
	beforeText?: string;
	afterText?: string;
	beforeHeading?: string | null;
	afterHeading?: string | null;
	beforeDepth?: number;
	afterDepth?: number;
	beforePrev?: string | null;
	afterPrev?: string | null;
	beforeTrust?: Trust;
	afterTrust?: Trust;
}

interface Recording {
	conceptId: number;
	name: string;
	version: number;
	at: string;
	change: Omit<ChangeSpec, "sections" | "fields">;
	held: Held[];
	nextSection: number;
	sectionChanges: SectionChange[];
	before: NoteFields;
	after: NoteFields;
	archived: boolean;
	beforeArchived: boolean;
	carry: VectorCarry;
	resolve: boolean;
}

/**
 * Write the held state and the change that led to it, then rebuild the index.
 * Runs inside the caller's transaction.
 */
function record(db: Database, run: Recording): ChangeResult {
	const { conceptId, held, after } = run;
	const body = held.map((section) => section.text).join("");

	db.query("DELETE FROM sections WHERE concept_id = ?").run(conceptId);
	const insert = db.query(
		`INSERT INTO sections (
			concept_id, sid, position, depth, heading, text, version,
			trust, checked_by, checked_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	held.forEach((section, position) => {
		insert.run(
			conceptId,
			section.sid,
			position,
			section.depth,
			section.heading,
			section.text,
			section.version,
			section.trust,
			section.checkedBy,
			section.checkedAt,
		);
	});

	const best = held.reduce<Trust>(
		(top, section) =>
			TRUST_RANK[section.trust] > TRUST_RANK[top] ? section.trust : top,
		"unverified",
	);

	db.query(
		`UPDATE concepts SET
			type = ?, title = ?, description = ?, status = ?, stale_after = ?,
			sources = ?, frontmatter = ?, archived = ?, version = ?, next_section = ?,
			trust = ?, content_hash = ?, byte_size = ?, updated_at = ?,
			indexed_at = datetime('now')
		WHERE id = ?`,
	).run(
		after.type,
		after.title,
		after.description,
		after.status,
		after.staleAfter,
		JSON.stringify(after.sources),
		JSON.stringify(after.extra),
		run.archived ? 1 : 0,
		run.version,
		run.nextSection,
		best,
		hashContent(body),
		Buffer.byteLength(body),
		run.at,
		conceptId,
	);

	const fieldChanges = diffFields(run.before, run.after);
	if (run.archived !== run.beforeArchived) {
		fieldChanges.push({
			field: "archived",
			before: run.beforeArchived,
			after: run.archived,
		});
	}

	// What the concept vector is made from: a change to any of the three
	// leaves the old one describing something else.
	if (
		fieldChanges.some((entry) =>
			["title", "description", "tags"].includes(entry.field),
		)
	) {
		db.query("DELETE FROM concept_embeddings WHERE concept_id = ?").run(
			conceptId,
		);
		db.query("DELETE FROM concept_embed_failures WHERE concept_id = ?").run(
			conceptId,
		);
	}

	const changeId = db
		.query<
			{ id: number },
			[number, number, string, string, string | null, ...(string | null)[]]
		>(
			`INSERT INTO changes (concept_id, version, at, kind, reason, client, project, by_name)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.get(
			conceptId,
			run.version,
			run.at,
			run.change.kind,
			run.change.reason ?? null,
			run.change.who.client ?? null,
			run.change.who.project ?? null,
			run.change.who.by ?? null,
		)?.id;
	if (changeId === undefined) {
		throw new Error("Failed to record the change");
	}

	// A section touched twice in one change is one entry: what it was before
	// the first touch and what it is after the last.
	const merged: SectionChange[] = [];
	for (const entry of run.sectionChanges) {
		const earlier = merged.find((other) => other.sid === entry.sid);
		if (earlier === undefined) {
			merged.push({ ...entry });
		} else if (earlier.op === "insert" && entry.op === "remove") {
			merged.splice(merged.indexOf(earlier), 1);
		} else {
			// What it was comes from the earlier touch, what it is from the later.
			// (null is a value for a heading and for "first", so only undefined
			// means "not recorded".)
			if (earlier.beforeText === undefined) {
				earlier.beforeText = entry.beforeText;
				earlier.beforeHeading = entry.beforeHeading;
				earlier.beforeDepth = entry.beforeDepth;
				earlier.beforeTrust = entry.beforeTrust;
			}
			if (earlier.beforePrev === undefined) {
				earlier.beforePrev = entry.beforePrev;
			}
			if (entry.afterText !== undefined) {
				earlier.afterText = entry.afterText;
				earlier.afterHeading = entry.afterHeading;
				earlier.afterDepth = entry.afterDepth;
				earlier.afterTrust = entry.afterTrust;
			}
			if (entry.afterPrev !== undefined) {
				earlier.afterPrev = entry.afterPrev;
			}
			// insert outranks everything, then remove, then update, then move.
			const rank = { insert: 3, remove: 2, update: 1, move: 0, check: 0 };
			if (rank[entry.op] > rank[earlier.op]) {
				earlier.op = entry.op;
			}
			if (earlier.op === "remove") {
				earlier.afterText = undefined;
				earlier.afterHeading = undefined;
				earlier.afterDepth = undefined;
				earlier.afterTrust = undefined;
				earlier.afterPrev = undefined;
			}
		}
	}

	const insertSection = db.query(
		`INSERT INTO change_sections (
			change_id, sid, op, before_text, after_text, before_heading, after_heading,
			before_depth, after_depth, before_prev, after_prev, before_trust, after_trust
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const entry of merged) {
		insertSection.run(
			changeId,
			entry.sid,
			entry.op,
			entry.beforeText ?? null,
			entry.afterText ?? null,
			entry.beforeHeading ?? null,
			entry.afterHeading ?? null,
			entry.beforeDepth ?? null,
			entry.afterDepth ?? null,
			prevColumn(entry.beforePrev),
			prevColumn(entry.afterPrev),
			entry.beforeTrust ?? null,
			entry.afterTrust ?? null,
		);
	}
	const insertField = db.query(
		"INSERT INTO change_fields (change_id, field, before, after) VALUES (?, ?, ?, ?)",
	);
	for (const entry of fieldChanges) {
		insertField.run(
			changeId,
			entry.field,
			JSON.stringify(entry.before ?? null),
			JSON.stringify(entry.after ?? null),
		);
	}

	const derived = refreshDerived(
		db,
		{
			conceptId,
			dir: directoryOf(`${run.name}.md`),
			sections: held,
			tags: after.tags,
			sources: after.sources,
		},
		run.carry,
	);
	if (run.resolve) {
		resolveLinks(db);
	}

	return {
		conceptId,
		version: run.version,
		changeId,
		chunks: derived.chunks,
		carried: derived.carried,
	};
}

/**
 * Where a section stood, as stored: the section it followed, an empty string
 * for the start, and NULL when the change did not say.
 */
function prevColumn(prev: string | null | undefined): string | null {
	return prev === undefined ? null : prev === null ? "" : prev;
}

/** Every field whose value differs, with what it was and what it is. */
function diffFields(
	before: NoteFields,
	after: NoteFields,
): Array<{ field: string; before: unknown; after: unknown }> {
	const out: Array<{ field: string; before: unknown; after: unknown }> = [];
	const scalars = [
		"type",
		"title",
		"description",
		"status",
		"staleAfter",
	] as const;
	for (const key of scalars) {
		if (before[key] !== after[key]) {
			out.push({
				field: key === "staleAfter" ? "stale_after" : key,
				before: before[key],
				after: after[key],
			});
		}
	}
	for (const key of ["tags", "sources"] as const) {
		if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
			out.push({ field: key, before: before[key], after: after[key] });
		}
	}
	const keys = new Set([
		...Object.keys(before.extra),
		...Object.keys(after.extra),
	]);
	for (const key of [...keys].sort()) {
		if (
			JSON.stringify(before.extra[key]) !== JSON.stringify(after.extra[key])
		) {
			out.push({
				field: `fields.${key}`,
				before: before.extra[key],
				after: after.extra[key],
			});
		}
	}
	return out;
}

/** The fields a stored note has now. */
function fieldsOf(db: Database, concept: ConceptRow): NoteFields {
	const tags = db
		.query<{ tag: string }, [number]>(
			"SELECT tag FROM tags WHERE concept_id = ? ORDER BY rowid",
		)
		.all(concept.id)
		.map((row) => row.tag);
	return {
		type: concept.type,
		title: concept.title,
		description: concept.description,
		status: concept.status,
		staleAfter: concept.stale_after,
		tags,
		sources: JSON.parse(concept.sources) as NoteFields["sources"],
		extra: JSON.parse(concept.frontmatter ?? "{}") as Record<string, unknown>,
	};
}

/** A note's directory in its virtual path; empty at the root. */
function directoryOf(path: string): string {
	const dir = posix.dirname(path);
	return dir === "." ? "" : dir;
}
