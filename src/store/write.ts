/**
 * Changing the note store on an agent's behalf: the guards, and the shape of
 * each write.
 *
 * `store.ts` records whatever it is told. This is what decides what it is told:
 * a quoted passage must occur once, a whole section may be replaced only if it
 * is still the version the agent read, a heading may not be lost. Every write
 * is worked out against a snapshot of the note, its new passages are embedded
 * before any transaction opens (so the database is held for milliseconds), and
 * then one immediate transaction checks that the note is still at the version
 * the snapshot was taken at and writes. If another session got in between, the
 * write is worked out again against the new note: a change to a different
 * passage lands, a change to the same passage is refused with what to do.
 */

import type { Database } from "bun:sqlite";
import { posix } from "node:path";
import type { EmbeddingProvider } from "../embed/provider.js";
import { toBlob } from "../embed/provider.js";
import {
	embedConceptVector,
	passageText,
	recordChunkFailure,
} from "../embed/run.js";
import { readActiveSpace, sameSpace } from "../embed/state.js";
import { chunkDocument } from "../sync/chunk.js";
import { typeDirectory } from "../sync/okf.js";
import { carryFrom, carryKey, type VectorCarry } from "./derive.js";
import { isRefusal, type Refusal, resolveNote } from "./read.js";
import { moveSource, rewriteLinks, writeTarget } from "./relink.js";
import { splitSections } from "./sections.js";
import {
	applySectionOps,
	type ChangeSpec,
	type ConceptRow,
	changeNote,
	createNote,
	directoryOf,
	fieldsOf,
	type Held,
	loadConcept,
	loadHeld,
	type NoteFields,
	type SectionOp,
	type Trust,
	type Who,
} from "./store.js";

export interface WriteContext {
	db: Database;
	/** The embedding provider this process holds, or why there is none. */
	provider: () => EmbeddingProvider | { unavailable: string };
	/** Who is writing: the client and the folder, as the server knows them. */
	who: Who;
	/** The instant to date a change, for tests. Defaults to now. */
	now?: () => string;
}

/** What a write answers with. */
export interface Written {
	note: string;
	/** The note's version after the write. */
	version: number;
	/** The change that was made, which `history` and `revert` take. */
	change?: number;
	/** The sections the write made or changed, with the version each is now. */
	sections?: Array<{ id: string; version: number }>;
	/** Set when nothing needed writing. */
	unchanged?: true;
	/** Set when the new text is searchable by keyword only, and why. */
	search?: string;
	/** Anything else worth telling the caller. */
	info?: string;
}

export function refuse(refused: string, next: string): Refusal {
	return { refused, next };
}

/** Writes retry this many times when another session changes the note first. */
const ATTEMPTS = 25;

/** A note read once, which a write is worked out against. */
export interface Snapshot {
	id: number;
	name: string;
	concept: ConceptRow;
	fields: NoteFields;
	sections: Held[];
}

export function snapshotOf(db: Database, id: number): Snapshot {
	const concept = loadConcept(db, id);
	return {
		id,
		name: concept.identifier,
		concept,
		fields: fieldsOf(db, concept),
		sections: loadHeld(db, id),
	};
}

/** What a write has worked out: the operations, and the fields to set. */
export interface Build {
	ops: SectionOp[];
	fields?: Partial<NoteFields> & { archived?: boolean };
	rename?: string;
	undoes?: number;
	/** Answered back as `info`. */
	info?: string;
	/** The caller's note about why. */
	reason?: string;
	/** There is nothing to write; say this and make no change. */
	skip?: string;
}

/** A section in the order it is changed: used to build operations one at a time. */
export class Planner {
	readonly ops: SectionOp[] = [];
	readonly work: Held[];
	/** Sections this plan made, which have no version the caller could have read. */
	readonly made = new Set<string>();
	private next: number;

	constructor(
		readonly name: string,
		sections: Held[],
		next: number,
	) {
		this.work = sections.map((section) => ({ ...section }));
		this.next = next;
	}

	find(sid: string): Held | undefined {
		return this.work.find((section) => section.sid === sid);
	}

	index(sid: string): number {
		return this.work.findIndex((section) => section.sid === sid);
	}

	body(): string {
		return this.work.map((section) => section.text).join("");
	}

	/** The ids a caller may name, for a refusal that says what exists. */
	ids(): string {
		return this.work.map((section) => section.sid).join(", ");
	}

	/** A section and the sections nested under it: those deeper, up to the next as shallow. */
	block(sid: string): string[] {
		const at = this.index(sid);
		const root = this.work[at];
		const out = [sid];
		if (root.depth === 0) {
			return out;
		}
		for (const section of this.work.slice(at + 1)) {
			if (section.depth <= root.depth) {
				break;
			}
			out.push(section.sid);
		}
		return out;
	}

	run(op: SectionOp): string[] {
		this.ops.push(op);
		const applied = applySectionOps(this.work, this.next, [op], this.name);
		this.next = applied.next;
		return applied.assigned;
	}

	/**
	 * Give a section new text. A heading line the text now holds starts a new
	 * section there; the first part keeps the id. The section's own heading line
	 * may change its words and depth but not go.
	 */
	setText(sid: string, text: string): Refusal | undefined {
		const current = this.find(sid);
		if (current === undefined) {
			return noSection(this.name, sid, this.ids());
		}
		if (text === current.text) {
			return undefined;
		}
		if (text.trim() === "") {
			return refuse(
				`That would leave ${sid} empty.`,
				`Use remove_section to take ${sid} out.`,
			);
		}
		const parts = splitSections(text);
		const first = parts[0];
		if (current.heading !== null && first.heading === null) {
			return refuse(
				`That removes the heading line of ${sid} ("${current.heading}").`,
				`Keep a heading line at the start of the text, change its words instead, or use remove_section to take ${sid} out.`,
			);
		}
		this.run({
			op: "update",
			sid,
			text: first.text,
			heading: first.heading,
			depth: first.depth,
		});
		let previous = sid;
		for (const part of parts.slice(1)) {
			previous = this.run({
				op: "insert",
				after: previous,
				depth: part.depth,
				heading: part.heading,
				text: part.text,
			})[0];
			this.made.add(previous);
		}
		return undefined;
	}

	/** New sections from `text` (more than one when it holds headings), after `after`. */
	insertText(after: string | null, text: string): string[] {
		const out: string[] = [];
		let previous = after;
		for (const part of splitSections(text)) {
			const sid = this.run({
				op: "insert",
				after: previous,
				depth: part.depth,
				heading: part.heading,
				text: part.text,
			})[0];
			this.made.add(sid);
			out.push(sid);
			previous = sid;
		}
		return out;
	}
}

export function noSection(name: string, sid: string, ids: string): Refusal {
	return refuse(
		`${name} has no section ${sid}.`,
		`Its sections are ${ids}. read_note shows each with its heading.`,
	);
}

/**
 * Work out a write against the note as it is now, embed what it adds, and
 * write it if the note has not moved since; otherwise work it out again.
 */
export async function commit(
	ctx: WriteContext,
	noteId: number,
	kind: string,
	input: { reason?: string; by?: string },
	build: (snap: Snapshot) => Build | Refusal,
): Promise<Written | Refusal> {
	const { db } = ctx;
	const made: VectorCarry = new Map();
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const snap = snapshotOf(db, noteId);
		const built = build(snap);
		if (isRefusal(built)) {
			return built;
		}
		if (built.skip !== undefined) {
			return {
				note: snap.name,
				version: snap.concept.version,
				unchanged: true,
				info: built.skip,
			};
		}

		const preview = snap.sections.map((section) => ({ ...section }));
		const applied = applySectionOps(
			preview,
			snap.concept.next_section,
			built.ops,
			snap.name,
		);
		const touched = [
			...new Set(
				applied.changes
					.filter((entry) => entry.op === "insert" || entry.op === "update")
					.map((entry) => entry.sid),
			),
		].filter((sid) => preview.some((section) => section.sid === sid));
		const body = preview.map((section) => section.text).join("");
		// What an earlier attempt of this same write already embedded is kept, so
		// working the write out again after losing a race costs no embedding
		// unless the other session's change put new text in play.
		const known = carryFrom(db, noteId);
		for (const [key, value] of made) {
			known.set(key, value);
		}
		const vectors = await newVectors(ctx, known, body);
		for (const [key, value] of vectors.carry) {
			made.set(key, value);
		}

		const spec: ChangeSpec = {
			kind,
			reason: built.reason ?? input.reason,
			who: whoOf(ctx, input.by),
			at: ctx.now?.(),
			sections: built.ops,
			fields: built.fields,
			rename: built.rename,
			undoes: built.undoes,
			carry: made,
		};
		const result = db
			.transaction(() => {
				if (loadConcept(db, noteId).version !== snap.concept.version) {
					return null;
				}
				return changeNote(db, noteId, spec);
			})
			.immediate();
		if (result === null) {
			continue;
		}

		const after = built.fields;
		const conceptVector =
			after !== undefined &&
			("title" in after || "description" in after || "tags" in after);
		const problems = await settle(
			ctx,
			noteId,
			vectors.failed,
			vectors.note,
			conceptVector,
		);
		return {
			note: built.rename ?? snap.name,
			version: result.version,
			change: result.changeId,
			...(touched.length === 0
				? {}
				: {
						sections: touched.map((sid) => ({
							id: sid,
							version: preview.find((s) => s.sid === sid)?.version ?? 1,
						})),
					}),
			...(problems === undefined ? {} : { search: problems }),
			...(built.info === undefined ? {} : { info: built.info }),
		};
	}
	return refuse(
		"The note kept changing while this was being written.",
		"Read the note again and repeat the change.",
	);
}

function whoOf(ctx: WriteContext, by: string | undefined): Who {
	return by === undefined || by === "" ? ctx.who : { ...ctx.who, by };
}

/** A passage the model could not embed: the text, and what went wrong. */
interface Failed {
	headingPath: string;
	contentHash: string;
	error: unknown;
}

interface Vectors {
	carry: VectorCarry;
	failed: Failed[];
	/** Why no vector was made at all, when none could be. */
	note?: string;
}

/**
 * Vectors for the passages a body has that the note does not already hold
 * one for, made before the transaction opens. Failing to make one never fails
 * the write: its passage is found by keyword and the failure is recorded once
 * the write has landed.
 */
export async function newVectors(
	ctx: WriteContext,
	known: VectorCarry,
	body: string,
): Promise<Vectors> {
	const carry: VectorCarry = new Map();
	const failed: Failed[] = [];
	const wanted = new Map<
		string,
		{ headingPath: string; text: string; hash: string }
	>();
	for (const piece of chunkDocument(body, 0, 0)) {
		const key = carryKey(piece.headingPath, piece.contentHash);
		const text = passageText(piece.headingPath, piece.content);
		if (!known.has(key) && !wanted.has(key) && text !== "") {
			wanted.set(key, {
				headingPath: piece.headingPath,
				text,
				hash: piece.contentHash,
			});
		}
	}
	if (wanted.size === 0) {
		return { carry, failed };
	}

	const provider = ctx.provider();
	if ("unavailable" in provider) {
		return {
			carry,
			failed,
			note: `${wanted.size} new passages are found by keyword only: ${provider.unavailable}`,
		};
	}
	const active = readActiveSpace(ctx.db);
	if (active === undefined || !sameSpace(active, provider)) {
		return {
			carry,
			failed,
			note:
				active === undefined
					? `${wanted.size} new passages are found by keyword only: the store has no embedding model yet`
					: `${wanted.size} new passages are found by keyword only: the store is embedded with ${active.model} and this server would use ${provider.model}`,
		};
	}

	for (const [key, item] of wanted) {
		try {
			const [vector] = await provider.embed([item.text]);
			carry.set(key, [
				{ model: provider.model, dim: provider.dim, vector: toBlob(vector) },
			]);
		} catch (error) {
			failed.push({
				headingPath: item.headingPath,
				contentHash: item.hash,
				error,
			});
		}
	}
	return { carry, failed };
}

/**
 * After a write has landed: record the passages that could not be embedded the
 * way a run of `embed` does, give the note its note-level vector when the write
 * changed what it is made from, and say in a sentence what is only searchable
 * by keyword.
 */
export async function settle(
	ctx: WriteContext,
	noteId: number,
	failed: Failed[],
	note: string | undefined,
	conceptVector: boolean,
): Promise<string | undefined> {
	const { db } = ctx;
	const provider = ctx.provider();
	const problems: string[] = [];
	if (note !== undefined) {
		problems.push(note);
	}

	if (!("unavailable" in provider)) {
		const active = readActiveSpace(db);
		if (active !== undefined && sameSpace(active, provider)) {
			for (const item of failed) {
				const ids = db
					.query<{ id: number }, [number, string, string, string, number]>(
						`SELECT id FROM chunks WHERE concept_id = ? AND heading_path = ?
						AND content_hash = ?
						AND id NOT IN (SELECT chunk_id FROM chunk_embeddings WHERE model = ? AND dim = ?)`,
					)
					.all(
						noteId,
						item.headingPath,
						item.contentHash,
						active.model,
						active.dim,
					);
				for (const row of ids) {
					recordChunkFailure(db, row.id, active, item.error);
				}
			}
			if (failed.length > 0) {
				const first = failed[0].error;
				problems.push(
					`${failed.length} new passages are found by keyword only: embedding failed (${first instanceof Error ? first.message : String(first)})`,
				);
			}
			if (conceptVector) {
				const result = await embedConceptVector(db, provider, noteId);
				if (result !== undefined) {
					const message =
						result.failed instanceof Error
							? result.failed.message
							: String(result.failed);
					problems.push(`the note's own vector failed (${message})`);
				}
			}
		}
	}
	return problems.length === 0 ? undefined : problems.join("; ");
}

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
		vectors.note,
		true,
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
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
		return value;
	}
	const found = resolveNote(db, value);
	if (isRefusal(found)) {
		return value;
	}
	return posix.relative(dir === "" ? "." : dir, `${found.name}.md`);
}

// ---------------------------------------------------------------------------
// edit

export interface EditItem {
	/** Look for `old` in this section only. */
	section?: string;
	/** The exact text to replace. */
	old?: string;
	/** What replaces it. */
	new?: string;
	/** A whole section's new text, with its heading line. */
	text?: string;
	/** The section version the caller read, for a whole-section replacement. */
	version?: number;
}

export interface EditInput {
	note: string;
	edits: EditItem[];
	reason?: string;
	by?: string;
}

/** Every position `needle` starts at in `haystack`, overlapping ones included. */
function occurrences(haystack: string, needle: string): number[] {
	const at: number[] = [];
	let from = haystack.indexOf(needle);
	while (from !== -1) {
		at.push(from);
		from = haystack.indexOf(needle, from + 1);
	}
	return at;
}

function describeCount(count: number): string {
	return count === 2 ? "twice" : `${count} times`;
}

export async function editNote(
	ctx: WriteContext,
	input: EditInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	if (input.edits.length === 0) {
		return refuse("There are no edits.", "Give at least one edit.");
	}

	return commit(ctx, found.id, "edit", input, (snap) => {
		const plan = new Planner(
			snap.name,
			snap.sections,
			snap.concept.next_section,
		);
		for (const [index, item] of input.edits.entries()) {
			const prefix = input.edits.length > 1 ? `Edit ${index + 1}: ` : "";
			const problem = applyEdit(plan, snap, item);
			if (problem !== undefined) {
				return refuse(prefix + problem.refused, problem.next);
			}
		}
		if (plan.ops.length === 0) {
			return refuse(
				"Nothing changed: the new text is the same as the old.",
				"Check what you meant to change.",
			);
		}
		return { ops: plan.ops };
	});
}

function applyEdit(
	plan: Planner,
	snap: Snapshot,
	item: EditItem,
): Refusal | undefined {
	if (item.old !== undefined) {
		return replaceQuoted(plan, item);
	}
	if (item.text !== undefined) {
		return replaceSection(plan, snap, item);
	}
	return refuse(
		"An edit needs `old` and `new`, or `section`, `text` and `version`.",
		"To change a passage, quote it exactly as `old` and give `new`. To replace a whole section, give its id, its new text and the version you read.",
	);
}

function replaceQuoted(plan: Planner, item: EditItem): Refusal | undefined {
	const old = item.old ?? "";
	if (old === "") {
		return refuse(
			"`old` is empty.",
			"Quote the exact passage to replace. To add text, use append or add_section.",
		);
	}
	if (item.new === undefined) {
		return refuse(
			"`new` is missing.",
			"Give the text that replaces the quoted passage (empty to delete it).",
		);
	}

	if (item.section !== undefined) {
		const section = plan.find(item.section);
		if (section === undefined) {
			return noSection(plan.name, item.section, plan.ids());
		}
		const at = occurrences(section.text, old);
		if (at.length === 0) {
			const elsewhere = plan.work
				.filter((other) => other.text.includes(old))
				.map((other) => other.sid);
			return refuse(
				`That passage is not in ${item.section}. It may have changed since you read it.`,
				elsewhere.length > 0
					? `It occurs in ${elsewhere.join(", ")}: name that section, or leave the section out. Otherwise read the section again.`
					: `Read the section again (read_note with sections: ["${item.section}"]) and quote what it says now.`,
			);
		}
		if (at.length > 1) {
			return refuse(
				`That passage occurs ${describeCount(at.length)} in ${item.section}.`,
				"Quote more of the surrounding text so it occurs once.",
			);
		}
		return plan.setText(
			item.section,
			section.text.slice(0, at[0]) +
				item.new +
				section.text.slice(at[0] + old.length),
		);
	}

	const body = plan.body();
	const at = occurrences(body, old);
	if (at.length === 0) {
		return refuse(
			"That passage is not in the note. It may have changed since you read it.",
			"Read the note again (read_note) and quote what it says now.",
		);
	}
	if (at.length > 1) {
		return refuse(
			`That passage occurs ${describeCount(at.length)} in the note.`,
			"Quote more of the surrounding text so it occurs once, or name the section to look in.",
		);
	}
	let start = 0;
	for (const section of plan.work) {
		const end = start + section.text.length;
		if (at[0] >= start && at[0] < end) {
			if (at[0] + old.length > end) {
				const next = plan.work[plan.index(section.sid) + 1];
				return refuse(
					`That passage runs across sections ${section.sid} and ${next?.sid ?? "the next"}.`,
					"Quote within one section, or replace the sections you mean as whole sections.",
				);
			}
			const local = at[0] - start;
			return plan.setText(
				section.sid,
				section.text.slice(0, local) +
					item.new +
					section.text.slice(local + old.length),
			);
		}
		start = end;
	}
	return refuse("That passage could not be placed.", "Try naming its section.");
}

function replaceSection(
	plan: Planner,
	snap: Snapshot,
	item: EditItem,
): Refusal | undefined {
	if (item.section === undefined || item.version === undefined) {
		return refuse(
			"Replacing a whole section needs its id and the version you read.",
			"Give `section` and `version` (read_note shows both), or quote a passage with `old` and `new`.",
		);
	}
	const section = plan.find(item.section);
	if (section === undefined) {
		return noSection(plan.name, item.section, plan.ids());
	}
	if (!plan.made.has(item.section)) {
		const read = snap.sections.find((other) => other.sid === item.section);
		if (read !== undefined && read.version !== item.version) {
			return refuse(
				`${item.section} is at version ${read.version}; you read version ${item.version}. It changed since you read it.`,
				`Read it again (read_note with sections: ["${item.section}"]) and redo the replacement, or quote a passage instead.`,
			);
		}
	}
	return plan.setText(item.section, item.text ?? "");
}

// ---------------------------------------------------------------------------
// sections

export interface AddSectionInput {
	note: string;
	heading: string;
	text?: string;
	/** A section id, "start" or "end" (the default). */
	after?: string;
	depth?: number;
	reason?: string;
	by?: string;
}

export async function addSection(
	ctx: WriteContext,
	input: AddSectionInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	const heading = input.heading.trim();
	if (heading === "" || heading.includes("\n")) {
		return refuse(
			"A heading is one line of words.",
			"Give the heading without the # marks.",
		);
	}
	const depth = input.depth ?? 2;
	if (!Number.isInteger(depth) || depth < 1 || depth > 6) {
		return refuse(
			"A heading's depth is 1 to 6.",
			"Use depth 2 for a section, 3 for a subsection.",
		);
	}

	return commit(ctx, found.id, "add_section", input, (snap) => {
		const plan = new Planner(
			snap.name,
			snap.sections,
			snap.concept.next_section,
		);
		const place = placeOf(plan, input.after ?? "end");
		if (isRefusal(place)) {
			return place;
		}
		const body = input.text?.trim() ?? "";
		const last = place.after === (plan.work.at(-1)?.sid ?? null);
		const text = `${"#".repeat(depth)} ${heading}\n${body === "" ? "" : `\n${body}\n`}${last ? "" : "\n"}`;
		plan.insertText(place.after, text);
		return { ops: plan.ops };
	});
}

/** Where "start", "end" or a section id puts something. */
function placeOf(
	plan: Planner,
	where: string,
): { after: string | null } | Refusal {
	if (where === "start") {
		return { after: null };
	}
	if (where === "end") {
		return { after: plan.work.at(-1)?.sid ?? null };
	}
	if (plan.find(where) === undefined) {
		return noSection(plan.name, where, plan.ids());
	}
	return { after: where };
}

export interface RemoveSectionInput {
	note: string;
	section: string;
	/** Take the sections nested under it too. */
	with_subsections?: boolean;
	reason?: string;
	by?: string;
}

export async function removeSection(
	ctx: WriteContext,
	input: RemoveSectionInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	return commit(ctx, found.id, "remove_section", input, (snap) => {
		const plan = new Planner(
			snap.name,
			snap.sections,
			snap.concept.next_section,
		);
		if (plan.find(input.section) === undefined) {
			return noSection(snap.name, input.section, plan.ids());
		}
		const doomed =
			input.with_subsections === true
				? plan.block(input.section)
				: [input.section];
		if (doomed.length >= plan.work.length) {
			return refuse(
				"That would leave the note with no text.",
				"Archive the note with archive_note instead, or keep a section.",
			);
		}
		const nested = plan.block(input.section).length - 1;
		for (const sid of doomed) {
			plan.run({ op: "remove", sid });
		}
		return {
			ops: plan.ops,
			info:
				input.with_subsections !== true && nested > 0
					? `${nested} nested sections stay; pass with_subsections to remove them too.`
					: undefined,
		};
	});
}

export interface MoveSectionInput {
	note: string;
	section: string;
	/** A section id or "start". */
	after: string;
	reason?: string;
	by?: string;
}

export async function moveSection(
	ctx: WriteContext,
	input: MoveSectionInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	return commit(ctx, found.id, "move_section", input, (snap) => {
		const plan = new Planner(
			snap.name,
			snap.sections,
			snap.concept.next_section,
		);
		if (plan.find(input.section) === undefined) {
			return noSection(snap.name, input.section, plan.ids());
		}
		const place = placeOf(plan, input.after);
		if (isRefusal(place)) {
			return place;
		}
		const block = plan.block(input.section);
		if (place.after !== null && block.includes(place.after)) {
			return refuse(
				`${input.after} is inside the section being moved.`,
				"Name a section outside it to move it after.",
			);
		}
		const before = plan.work.map((section) => section.sid);
		let previous = place.after;
		for (const sid of block) {
			plan.run({ op: "move", sid, after: previous });
			previous = sid;
		}
		if (before.join() === plan.work.map((section) => section.sid).join()) {
			return refuse(
				`${input.section} is already there.`,
				"Name a different place.",
			);
		}
		return { ops: plan.ops };
	});
}

// ---------------------------------------------------------------------------
// append

export interface AppendInput {
	note: string;
	text: string;
	section?: string;
	source?: string;
	reason?: string;
	by?: string;
}

export async function appendFinding(
	ctx: WriteContext,
	input: AppendInput,
): Promise<Written | Refusal> {
	const found = resolveNote(ctx.db, input.note);
	if (isRefusal(found)) {
		return found;
	}
	const finding = input.text.trim();
	if (finding === "") {
		return refuse("There is nothing to append.", "Give the finding as text.");
	}

	return commit(ctx, found.id, "append", input, (snap) => {
		const plan = new Planner(
			snap.name,
			snap.sections,
			snap.concept.next_section,
		);
		const sid = input.section ?? defaultSection(snap);
		const section = plan.find(sid);
		if (section === undefined) {
			return noSection(snap.name, sid, plan.ids());
		}

		const trailing = /\s*$/.exec(section.text)?.[0] ?? "";
		const kept = section.text.slice(0, section.text.length - trailing.length);
		const lastLine = kept.split("\n").at(-1) ?? "";
		const item = /^\s*([-*+]|\d+[.)])\s/;
		const joined = item.test(finding) && item.test(lastLine) ? "\n" : "\n\n";
		const problem = plan.setText(
			sid,
			`${kept}${joined}${finding}${trailing === "" ? "\n" : trailing}`,
		);
		if (problem !== undefined) {
			return problem;
		}

		let fields: Build["fields"];
		let info: string | undefined;
		if (input.source !== undefined && input.source.trim() !== "") {
			const entry = sourceEntry(
				ctx.db,
				input.source,
				directoryOf(`${snap.name}.md`),
			);
			if (snap.fields.sources.includes(entry)) {
				info = "That source was already listed.";
			} else {
				fields = { sources: [...snap.fields.sources, entry] };
			}
		}
		return { ops: plan.ops, fields, info };
	});
}

/** The section a finding goes in: a hub's research list, else key findings, else the last. */
function defaultSection(snap: Snapshot): string {
	const named = (heading: string): string | undefined =>
		snap.sections.find(
			(section) => section.heading?.trim().toLowerCase() === heading,
		)?.sid;
	const hub = snap.fields.type.toLowerCase() === "topic";
	return (
		(hub ? named("research") : undefined) ??
		named("key findings") ??
		snap.sections.at(-1)?.sid ??
		"s1"
	);
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
	sources?: string[];
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

		let sources: NoteFields["sources"] =
			input.sources === undefined
				? snap.fields.sources
				: input.sources.map((source) => sourceEntry(ctx.db, source, dir));
		sources = unique([
			...sources,
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
	/** Section ids; all of them when left out. */
	sections?: string[];
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
			const wanted =
				input.sections ?? snap.sections.map((section) => section.sid);
			const ids = snap.sections.map((section) => section.sid);
			const missing = wanted.filter((sid) => !ids.includes(sid));
			if (missing.length > 0) {
				return noSection(snap.name, missing.join(", "), ids.join(", "));
			}
			const ops: SectionOp[] = [];
			for (const sid of wanted) {
				const section = snap.sections.find((s) => s.sid === sid);
				if (section !== undefined && RANK[section.trust] < RANK[trust]) {
					ops.push({ op: "check", sid, trust, by, at });
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
