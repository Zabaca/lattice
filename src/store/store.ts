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
import { hashContent } from "../markdown/scan.js";
import {
	carryFrom,
	refreshDerived,
	resolveLinksAround,
	type StoredVector,
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
			/** Give the section this id (an undo bringing back a removed one). */
			sid?: string;
			/** The version it starts at; 1 for a new section. */
			version?: number;
	  }
	| {
			op: "update";
			sid: string;
			text: string;
			heading?: string | null;
			depth?: number;
	  }
	| { op: "remove"; sid: string }
	| { op: "move"; sid: string; after: string | null }
	/** Set who has checked a section. The text and its version are untouched. */
	| {
			op: "check";
			sid: string;
			trust: Trust;
			by: string | null;
			at: string | null;
	  };

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
	/**
	 * The note's own vector for the title, description and tags this change
	 * leaves it with, made before the transaction opened. Without it a change
	 * to any of the three leaves the note with no vector until `embed` runs.
	 */
	conceptVectors?: StoredVector[];
	/** The note's new name (it keeps answering to the old one). */
	rename?: string;
	/** The change this one undoes. */
	undoes?: number;
	/** Re-point the links around this note. Off for a bulk load that does it once. */
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
export interface Held {
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

export interface ConceptRow {
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
	change: Omit<ChangeSpec, "sections" | "fields" | "rename" | "undoes">,
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
				afterVersion: 1,
				afterTrust: "unverified",
			});
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
			oldName: null,
			version: 1,
			at,
			change,
			held,
			nextSection: next,
			sectionChanges,
			orderBefore: null,
			before: empty,
			after: note.fields,
			archived: note.archived ?? false,
			beforeArchived: false,
			carry: change.carry ?? new Map(),
			resolve: change.resolve ?? true,
			undoes: null,
		});
	})();
}

/** What a change did to one section, as it is recorded. */
export interface SectionChange {
	sid: string;
	op: "insert" | "update" | "remove" | "move" | "check";
	beforeText?: string;
	afterText?: string;
	beforeHeading?: string | null;
	afterHeading?: string | null;
	beforeDepth?: number;
	afterDepth?: number;
	beforeVersion?: number;
	afterVersion?: number;
	beforeTrust?: Trust;
	afterTrust?: Trust;
	beforeBy?: string | null;
	beforeAt?: string | null;
	moved?: boolean;
}

export interface Applied {
	/** The number the next section would be given. */
	next: number;
	changes: SectionChange[];
	/** The ids the inserts were given, in order. */
	assigned: string[];
}

/**
 * Work out what a list of section operations does to a note's sections: the
 * sections after them, in `held` (changed in place), what each section was and
 * became, and the ids new sections were given. A section the operations touch
 * is unchecked again and its version rises by one, however many operations
 * touched it; a section only moved or checked keeps its version.
 *
 * The write layer calls this to see a change before making it, and
 * `changeNote` calls it to make it, so the two cannot disagree.
 */
export function applySectionOps(
	held: Held[],
	next: number,
	ops: SectionOp[],
	note = "the note",
): Applied {
	const changes: SectionChange[] = [];
	const assigned: string[] = [];
	const touched = new Set<string>();
	const inserted = new Set<string>();

	const indexOf = (sid: string): number => {
		const at = held.findIndex((section) => section.sid === sid);
		if (at === -1) {
			throw new Error(`No section ${sid} in ${note}`);
		}
		return at;
	};
	const placeAfter = (after: string | null): number =>
		after === null ? 0 : indexOf(after) + 1;

	for (const op of ops) {
		if (op.op === "insert") {
			let sid = op.sid;
			if (sid === undefined) {
				sid = `s${next++}`;
			} else {
				if (held.some((section) => section.sid === sid)) {
					throw new Error(`Section ${sid} already exists in ${note}`);
				}
				const number = Number(sid.slice(1));
				if (Number.isInteger(number) && number >= next) {
					next = number + 1;
				}
			}
			const version = op.version ?? 1;
			held.splice(placeAfter(op.after), 0, {
				sid,
				depth: op.depth,
				heading: op.heading,
				text: op.text,
				version,
				trust: "unverified",
				checkedBy: null,
				checkedAt: null,
			});
			changes.push({
				sid,
				op: "insert",
				afterText: op.text,
				afterHeading: op.heading,
				afterDepth: op.depth,
				afterVersion: version,
				afterTrust: "unverified",
			});
			assigned.push(sid);
			inserted.add(sid);
			touched.add(sid);
		} else if (op.op === "update") {
			const section = held[indexOf(op.sid)];
			changes.push({
				sid: op.sid,
				op: "update",
				beforeText: section.text,
				afterText: op.text,
				beforeHeading: section.heading,
				afterHeading: op.heading === undefined ? section.heading : op.heading,
				beforeDepth: section.depth,
				afterDepth: op.depth ?? section.depth,
				beforeVersion: section.version,
				beforeTrust: section.trust,
				afterTrust: "unverified",
				beforeBy: section.checkedBy,
				beforeAt: section.checkedAt,
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
			changes.push({
				sid: op.sid,
				op: "remove",
				beforeText: section.text,
				beforeHeading: section.heading,
				beforeDepth: section.depth,
				beforeVersion: section.version,
				beforeTrust: section.trust,
				beforeBy: section.checkedBy,
				beforeAt: section.checkedAt,
			});
			held.splice(at, 1);
			touched.delete(op.sid);
		} else if (op.op === "move") {
			const section = held[indexOf(op.sid)];
			held.splice(indexOf(op.sid), 1);
			held.splice(placeAfter(op.after), 0, section);
			changes.push({ sid: op.sid, op: "move", moved: true });
		} else {
			const section = held[indexOf(op.sid)];
			changes.push({
				sid: op.sid,
				op: "check",
				beforeTrust: section.trust,
				afterTrust: op.trust,
				beforeBy: section.checkedBy,
				beforeAt: section.checkedAt,
			});
			section.trust = op.trust;
			section.checkedBy = op.by;
			section.checkedAt = op.at;
		}
	}

	for (const section of held) {
		if (!touched.has(section.sid)) {
			continue;
		}
		if (!inserted.has(section.sid)) {
			section.version += 1;
		}
		section.trust = "unverified";
		section.checkedBy = null;
		section.checkedAt = null;
		for (const entry of changes) {
			if (entry.sid === section.sid && entry.op === "update") {
				entry.afterVersion = section.version;
			}
		}
	}

	return { next, changes, assigned };
}

/** Change a note that exists: its sections, its fields, or both. */
export function changeNote(
	db: Database,
	conceptId: number,
	change: ChangeSpec,
): ChangeResult {
	return db.transaction(() => {
		const at = change.at ?? new Date().toISOString();
		const concept = loadConcept(db, conceptId);
		const held = loadHeld(db, conceptId);
		const before = fieldsOf(db, concept);
		const orderBefore = held.map((section) => section.sid);

		const applied = applySectionOps(
			held,
			concept.next_section,
			change.sections ?? [],
			concept.identifier,
		);
		const orderChanged =
			JSON.stringify(orderBefore) !==
			JSON.stringify(held.map((section) => section.sid));

		const after: NoteFields = { ...before, ...stripArchived(change.fields) };
		const carry = carryFrom(db, conceptId);
		for (const [key, vectors] of change.carry ?? []) {
			carry.set(key, vectors);
		}

		return record(db, {
			conceptId,
			name: change.rename ?? concept.identifier,
			oldName: change.rename === undefined ? null : concept.identifier,
			version: concept.version + 1,
			at,
			change,
			held,
			nextSection: applied.next,
			sectionChanges: applied.changes,
			orderBefore: orderChanged ? orderBefore : null,
			before,
			after,
			archived: change.fields?.archived ?? concept.archived === 1,
			beforeArchived: concept.archived === 1,
			carry,
			resolve: change.resolve ?? true,
			undoes: change.undoes ?? null,
		});
	})();
}

/** A note's row, or a failure when it is not there. */
export function loadConcept(db: Database, conceptId: number): ConceptRow {
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
	return concept;
}

/** A note's sections as stored, in order. */
export function loadHeld(db: Database, conceptId: number): Held[] {
	return db
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
}

export function stripArchived(
	fields: ChangeSpec["fields"],
): Partial<NoteFields> | undefined {
	if (fields === undefined) {
		return undefined;
	}
	const { archived: _archived, ...rest } = fields;
	return rest;
}

interface Recording {
	conceptId: number;
	name: string;
	/** The name the note had, when this change renames it. */
	oldName: string | null;
	version: number;
	at: string;
	change: Omit<ChangeSpec, "sections" | "fields" | "rename" | "undoes">;
	held: Held[];
	nextSection: number;
	sectionChanges: SectionChange[];
	/** The sections' order before, when this change altered it. */
	orderBefore: string[] | null;
	before: NoteFields;
	after: NoteFields;
	archived: boolean;
	beforeArchived: boolean;
	carry: VectorCarry;
	resolve: boolean;
	undoes: number | null;
}

/** insert outranks remove, then update, then check, then move. */
const OP_RANK: Record<SectionChange["op"], number> = {
	insert: 4,
	remove: 3,
	update: 2,
	check: 1,
	move: 0,
};

const BEFORE_KEYS = [
	"beforeText",
	"beforeHeading",
	"beforeDepth",
	"beforeVersion",
	"beforeTrust",
	"beforeBy",
	"beforeAt",
] as const;
const AFTER_KEYS = [
	"afterText",
	"afterHeading",
	"afterDepth",
	"afterVersion",
	"afterTrust",
] as const;

/**
 * A section touched twice in one change is one entry: what it was before the
 * first touch and what it is after the last. (undefined is "not recorded";
 * null is a value, for a heading and for who checked it.)
 */
function mergeEntries(entries: SectionChange[]): SectionChange[] {
	const merged = new Map<string, SectionChange>();
	for (const entry of entries) {
		const earlier = merged.get(entry.sid);
		if (earlier === undefined) {
			merged.set(entry.sid, { ...entry });
			continue;
		}
		if (earlier.op === "insert" && entry.op === "remove") {
			merged.delete(entry.sid);
			continue;
		}
		const target = earlier as unknown as Record<string, unknown>;
		const source = entry as unknown as Record<string, unknown>;
		if (earlier.op !== "insert") {
			for (const key of BEFORE_KEYS) {
				if (target[key] === undefined) {
					target[key] = source[key];
				}
			}
		}
		for (const key of AFTER_KEYS) {
			if (source[key] !== undefined) {
				target[key] = source[key];
			}
		}
		earlier.moved = earlier.moved === true || entry.moved === true;
		if (OP_RANK[entry.op] > OP_RANK[earlier.op]) {
			earlier.op = entry.op;
		}
		if (earlier.op === "remove") {
			for (const key of AFTER_KEYS) {
				target[key] = undefined;
			}
		}
	}
	return [...merged.values()];
}

/**
 * Write the held state and the change that led to it, then rebuild the index.
 * Runs inside the caller's transaction.
 */
function record(db: Database, run: Recording): ChangeResult {
	const { conceptId, held, after } = run;
	const body = held.map((section) => section.text).join("");
	const directory = directoryOf(`${run.name}.md`);

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
			path = ?, identifier = ?, dir = ?,
			type = ?, title = ?, description = ?, status = ?, stale_after = ?,
			sources = ?, frontmatter = ?, archived = ?, version = ?, next_section = ?,
			trust = ?, content_hash = ?, byte_size = ?, updated_at = ?,
			indexed_at = datetime('now')
		WHERE id = ?`,
	).run(
		`${run.name}.md`,
		run.name,
		directory,
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
	if (run.oldName !== null) {
		// The old name keeps answering; a name the note is taking back stops
		// being an old one.
		db.query("DELETE FROM note_names WHERE name = ?").run(run.name);
		db.query(
			"INSERT OR REPLACE INTO note_names (name, concept_id) VALUES (?, ?)",
		).run(run.oldName, conceptId);
	}

	const fieldChanges = diffFields(run.before, run.after);
	if (run.archived !== run.beforeArchived) {
		fieldChanges.push({
			field: "archived",
			before: run.beforeArchived,
			after: run.archived,
		});
	}
	if (run.oldName !== null) {
		fieldChanges.push({ field: "name", before: run.oldName, after: run.name });
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
		for (const vector of run.change.conceptVectors ?? []) {
			db.query(
				"INSERT INTO concept_embeddings (concept_id, model, dim, vector) VALUES (?, ?, ?, ?)",
			).run(conceptId, vector.model, vector.dim, vector.vector);
		}
	}

	const changeId = db
		.query<{ id: number }, (string | number | null)[]>(
			`INSERT INTO changes (
				concept_id, version, at, kind, reason, client, project, by_name,
				undoes, order_before
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
			run.undoes,
			run.orderBefore === null ? null : JSON.stringify(run.orderBefore),
		)?.id;
	if (changeId === undefined) {
		throw new Error("Failed to record the change");
	}

	const insertSection = db.query(
		`INSERT INTO change_sections (
			change_id, sid, op, before_text, after_text, before_heading, after_heading,
			before_depth, after_depth, before_version, after_version,
			before_trust, after_trust, before_by, before_at, moved
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const entry of mergeEntries(run.sectionChanges)) {
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
			entry.beforeVersion ?? null,
			entry.afterVersion ?? null,
			entry.beforeTrust ?? null,
			entry.afterTrust ?? null,
			entry.beforeBy ?? null,
			entry.beforeAt ?? null,
			entry.moved === true ? 1 : 0,
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
			dir: directory,
			sections: held,
			tags: after.tags,
			sources: after.sources,
		},
		run.carry,
	);
	if (run.resolve) {
		resolveLinksAround(db, conceptId);
	}

	return {
		conceptId,
		version: run.version,
		changeId,
		chunks: derived.chunks,
		carried: derived.carried,
	};
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
export function fieldsOf(db: Database, concept: ConceptRow): NoteFields {
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
export function directoryOf(path: string): string {
	const dir = posix.dirname(path);
	return dir === "." ? "" : dir;
}
