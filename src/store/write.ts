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
import type { EmbeddingProvider } from "../embed/provider.js";
import { toBlob } from "../embed/provider.js";
import {
	conceptText,
	passageText,
	recordChunkFailure,
	recordConceptFailure,
} from "../embed/run.js";
import { readActiveSpace, sameSpace } from "../embed/state.js";
import { chunkDocument } from "../markdown/chunk.js";
import {
	carryFrom,
	carryKey,
	type StoredVector,
	type VectorCarry,
} from "./derive.js";
import { isRefusal, type Refusal } from "./read.js";
import { splitSections } from "./sections.js";
import {
	applySectionOps,
	type ChangeSpec,
	type ConceptRow,
	changeNote,
	fieldsOf,
	type Held,
	loadConcept,
	loadHeld,
	type NoteFields,
	type SectionOp,
	stripArchived,
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

	/**
	 * Close the plan: every section but the last must end in a newline, or the
	 * next heading line would be glued onto its last line, so any that lacks one
	 * gets it; then the joined text must split back into exactly these sections.
	 * Run it last, after every change the plan makes.
	 */
	finish(): Refusal | undefined {
		// Only the first section may open with blank lines (they sit above the
		// first heading); a section moved or placed elsewhere would hand them to
		// the section before it, so they are dropped.
		for (const section of this.work.slice(1)) {
			const blank = /^(?:[ \t]*\n)+/.exec(section.text);
			if (section.heading !== null && blank !== null) {
				this.run({
					op: "update",
					sid: section.sid,
					text: section.text.slice(blank[0].length),
				});
			}
		}
		for (const section of this.work.slice(0, -1)) {
			if (!section.text.endsWith("\n")) {
				this.run({ op: "update", sid: section.sid, text: `${section.text}\n` });
			}
		}
		return structureProblem(this.work);
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

/**
 * Whether sections joined and split again come back as the same sections. A
 * heading line glued to the text before it, a code block left open that swallows
 * the headings after it, or a section moved away from its heading all fail it,
 * and a note that fails it would read back differently from how it was written.
 */
export function structureProblem(
	sections: Array<{ heading: string | null; depth: number; text: string }>,
): Refusal | undefined {
	const parts = splitSections(sections.map((section) => section.text).join(""));
	const same =
		parts.length === sections.length &&
		parts.every(
			(part, i) =>
				part.text === sections[i].text &&
				part.heading === sections[i].heading &&
				part.depth === sections[i].depth,
		);
	if (same) {
		return undefined;
	}
	return refuse(
		"That would change where the note's sections split: a heading would be joined onto the text before it, an open code block would swallow the headings after it, or a section would lose its heading.",
		"Close any code block you open, keep a heading line first in each section, and read the note again before retrying.",
	);
}

/** The plan's operations once it is closed, or the refusal closing it gave. */
export function finished(
	plan: Planner,
	rest: Partial<Build> = {},
): Build | Refusal {
	const problem = plan.finish();
	return problem ?? { ops: plan.ops, ...rest };
}

/** A section as the caller read it, which a write may name to be refused if it moved. */
export function staleSection(
	snap: Snapshot,
	sid: string,
	read: number,
): Refusal | undefined {
	const now = snap.sections.find((section) => section.sid === sid);
	if (now === undefined || now.version === read) {
		return undefined;
	}
	return refuse(
		`${sid} is at version ${now.version}; you read version ${read}. It changed since you read it.`,
		`Read it again (read_note with sections: ["${sid}"]) and redo the change.`,
	);
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
	const madeNote = new Map<string, StoredVector[]>();
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
		if (preview.length === 0 && snap.sections.length > 0) {
			return refuse(
				"That would leave the note with no text.",
				"Archive the note with archive_note instead, or keep a section.",
			);
		}
		const broken = structureProblem(preview);
		if (broken !== undefined) {
			return broken;
		}
		const body = preview.map((section) => section.text).join("");

		// The note's own vector is made from its title, description and tags; a
		// change to any of them needs the new one before the transaction opens.
		const nextFields = { ...snap.fields, ...stripArchived(built.fields) };
		const conceptChanged =
			JSON.stringify([
				nextFields.title,
				nextFields.description,
				nextFields.tags,
			]) !==
			JSON.stringify([
				snap.fields.title,
				snap.fields.description,
				snap.fields.tags,
			]);
		const noteText = conceptChanged
			? conceptText(nextFields.title, nextFields.description, nextFields.tags)
			: "";
		const noteVector =
			noteText === ""
				? undefined
				: await conceptVector(ctx, noteText, madeNote);

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
			conceptVectors: noteVector?.vectors,
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

		const problems = await settle(
			ctx,
			noteId,
			vectors.failed,
			[vectors.note, noteVector?.note],
			noteVector?.failed,
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

export function whoOf(ctx: WriteContext, by: string | undefined): Who {
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

	const usable = usableProvider(ctx);
	if ("why" in usable) {
		return {
			carry,
			failed,
			note: `${wanted.size} new passages are found by keyword only: ${usable.why}`,
		};
	}
	const { provider } = usable;

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
 * The provider to embed with, or a sentence saying why there is none: it may
 * not load, and the store may be embedded with another model.
 */
function usableProvider(
	ctx: WriteContext,
): { provider: EmbeddingProvider } | { why: string } {
	const provider = ctx.provider();
	if ("unavailable" in provider) {
		return { why: provider.unavailable };
	}
	const active = readActiveSpace(ctx.db);
	if (active === undefined) {
		return { why: "the store has no embedding model yet" };
	}
	if (!sameSpace(active, provider)) {
		return {
			why: `the store is embedded with ${active.model} and this server would use ${provider.model}`,
		};
	}
	return { provider };
}

/**
 * The note's own vector for `text`, made before the transaction opens. Kept by
 * text across the attempts of one write. A failure never fails the write: the
 * note is found without it and the failure is recorded once the write lands.
 */
export async function conceptVector(
	ctx: WriteContext,
	text: string,
	cache: Map<string, StoredVector[]>,
): Promise<{ vectors?: StoredVector[]; failed?: unknown; note?: string }> {
	const cached = cache.get(text);
	if (cached !== undefined) {
		return { vectors: cached };
	}
	const usable = usableProvider(ctx);
	if ("why" in usable) {
		return { note: `the note's own vector was not made: ${usable.why}` };
	}
	try {
		const [vector] = await usable.provider.embed([text]);
		const vectors = [
			{
				model: usable.provider.model,
				dim: usable.provider.dim,
				vector: toBlob(vector),
			},
		];
		cache.set(text, vectors);
		return { vectors };
	} catch (error) {
		return { failed: error };
	}
}

/**
 * After a write has landed: record the passages (and the note's own vector)
 * that could not be embedded the way a run of `embed` does, and say in a
 * sentence what is only searchable by keyword.
 */
export async function settle(
	ctx: WriteContext,
	noteId: number,
	failed: Failed[],
	notes: Array<string | undefined>,
	conceptFailed?: unknown,
): Promise<string | undefined> {
	const { db } = ctx;
	const problems = notes.filter((note): note is string => note !== undefined);
	const message = (error: unknown): string =>
		error instanceof Error ? error.message : String(error);

	const usable = usableProvider(ctx);
	if ("provider" in usable) {
		const active = readActiveSpace(db);
		if (active !== undefined) {
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
				problems.push(
					`${failed.length} new passages are found by keyword only: embedding failed (${message(failed[0].error)})`,
				);
			}
			if (conceptFailed !== undefined) {
				recordConceptFailure(db, noteId, active, conceptFailed);
				problems.push(
					`the note's own vector failed (${message(conceptFailed)})`,
				);
			}
		}
	}
	return problems.length === 0 ? undefined : problems.join("; ");
}
