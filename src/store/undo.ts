/**
 * Undoing: one change, or a whole note back to an earlier version.
 *
 * Both are new changes, so they are in the history and can be undone in turn.
 * Undoing one change leaves the changes before and after it alone, which is
 * why it is refused when a later change touched the same section or field: the
 * later change was made on top of this one, and taking this one out from under
 * it would destroy newer work. The refusal names that change.
 */

import type { Database } from "bun:sqlite";
import type { Refusal } from "./read.js";
import {
	currentState,
	isRefusal,
	isUndone,
	resolveNote,
	rewind,
} from "./read.js";
import type { NoteFields, Trust } from "./store.js";
import {
	type Build,
	commit,
	Planner,
	refuse,
	type Snapshot,
	type WriteContext,
	type Written,
} from "./write.js";

interface ChangeRow {
	id: number;
	concept_id: number;
	version: number;
	kind: string;
	order_before: string | null;
	identifier: string;
}

interface EntryRow {
	sid: string;
	op: string;
	before_text: string | null;
	after_text: string | null;
	before_heading: string | null;
	after_heading: string | null;
	before_depth: number | null;
	after_depth: number | null;
	before_version: number | null;
	before_trust: Trust | null;
	after_trust: Trust | null;
	before_by: string | null;
	before_at: string | null;
	moved: number;
}

export interface RevertInput {
	/** The change to undo. */
	change?: number;
	/** Or a note, with the version to put it back to. */
	note?: string;
	version?: number;
	reason?: string;
	by?: string;
}

export async function revert(
	ctx: WriteContext,
	input: RevertInput,
): Promise<Written | Refusal> {
	if (input.change !== undefined) {
		return revertChange(ctx, input.change, input);
	}
	if (input.note !== undefined && input.version !== undefined) {
		return revertNote(ctx, input.note, input.version, input);
	}
	return refuse(
		"revert needs a change to undo, or a note and a version to put it back to.",
		"Give `change` (history lists them), or `note` and `version`.",
	);
}

// ---------------------------------------------------------------------------
// one change

async function revertChange(
	ctx: WriteContext,
	changeId: number,
	input: RevertInput,
): Promise<Written | Refusal> {
	const { db } = ctx;
	const row = db
		.query<ChangeRow, [number]>(
			`SELECT ch.id, ch.concept_id, ch.version, ch.kind, ch.order_before, c.identifier
			FROM changes ch JOIN concepts c ON c.id = ch.concept_id WHERE ch.id = ?`,
		)
		.get(changeId);
	if (row === null) {
		return refuse(
			`There is no change ${changeId}.`,
			"Use history to list changes and their ids.",
		);
	}
	if (row.kind === "import" || row.version === 1) {
		return refuse(
			`Change ${changeId} made ${row.identifier}.`,
			"Archive the note with archive_note to take it out of answers; a note's first change cannot be undone.",
		);
	}
	if (isUndone(db, changeId)) {
		const by = db
			.query<{ id: number }, [number]>(
				"SELECT id FROM changes WHERE undoes = ? ORDER BY id DESC LIMIT 1",
			)
			.get(changeId);
		return refuse(
			`Change ${changeId} was already undone by change ${by?.id}.`,
			`To bring it back, undo change ${by?.id}.`,
		);
	}

	return commit(
		ctx,
		row.concept_id,
		"revert",
		{
			reason: input.reason ?? `undoes change ${changeId}`,
			by: input.by,
		},
		(snap) => undoOf(db, row, snap),
	);
}

function undoOf(db: Database, row: ChangeRow, snap: Snapshot): Build | Refusal {
	const entries = db
		.query<EntryRow, [number]>(
			"SELECT * FROM change_sections WHERE change_id = ? ORDER BY rowid",
		)
		.all(row.id);
	const fields = db
		.query<
			{ field: string; before: string | null; after: string | null },
			[number]
		>(
			"SELECT field, before, after FROM change_fields WHERE change_id = ? ORDER BY rowid",
		)
		.all(row.id);

	// A later change on top of this one's sections or fields blocks the undo.
	const later = db
		.query<
			{
				id: number;
				version: number;
				kind: string;
				at: string;
				by: string | null;
			},
			[number, number]
		>(
			`SELECT id, version, kind, at, coalesce(by_name, client) AS by FROM changes
			WHERE concept_id = ? AND version > ? ORDER BY version`,
		)
		.all(row.concept_id, row.version);
	const mine = new Set(entries.map((entry) => entry.sid));
	const myFields = new Set(fields.map((field) => field.field));
	for (const change of later) {
		const sectionsOf = db
			.query<{ sid: string }, [number]>(
				"SELECT sid FROM change_sections WHERE change_id = ?",
			)
			.all(change.id)
			.map((entry) => entry.sid);
		const fieldsOf = db
			.query<{ field: string }, [number]>(
				"SELECT field FROM change_fields WHERE change_id = ?",
			)
			.all(change.id)
			.map((entry) => entry.field);
		const section = sectionsOf.find((sid) => mine.has(sid));
		const field = fieldsOf.find((name) => myFields.has(name));
		if (section !== undefined || field !== undefined) {
			const what =
				section !== undefined ? `section ${section}` : `the ${field} field`;
			return refuse(
				`Change ${change.id} (${change.kind}${change.by === null ? "" : `, by ${change.by}`}, ${change.at.slice(0, 10)}) also changed ${what}, after change ${row.id}.`,
				`Undo change ${change.id} first, or edit ${what} directly.`,
			);
		}
	}

	const plan = new Planner(snap.name, snap.sections, snap.concept.next_section);
	const order: string[] =
		row.order_before === null ? [] : (JSON.parse(row.order_before) as string[]);

	// Text and headings first, then the sections that come back, then order.
	for (const entry of entries) {
		if (entry.op === "insert") {
			plan.run({ op: "remove", sid: entry.sid });
		}
	}
	for (const entry of entries) {
		if (entry.op === "insert" || entry.op === "remove") {
			continue;
		}
		if (
			entry.before_text !== null &&
			entry.before_text !== plan.find(entry.sid)?.text
		) {
			plan.run({
				op: "update",
				sid: entry.sid,
				text: entry.before_text,
				heading: entry.before_heading,
				depth: entry.before_depth ?? undefined,
			});
		} else if (
			entry.before_text === null &&
			entry.before_trust !== null &&
			entry.before_trust !== entry.after_trust
		) {
			plan.run({
				op: "check",
				sid: entry.sid,
				trust: entry.before_trust,
				by: entry.before_by,
				at: entry.before_at,
			});
		}
	}
	const removed = new Set(
		entries.filter((entry) => entry.op === "remove").map((entry) => entry.sid),
	);
	const moved = new Set(
		entries.filter((entry) => entry.moved === 1).map((entry) => entry.sid),
	);
	// Walk the recorded order so each section finds its neighbour already placed.
	const sequence = order.length > 0 ? order : entries.map((entry) => entry.sid);
	for (const sid of sequence) {
		if (!removed.has(sid) && !moved.has(sid)) {
			continue;
		}
		const after = neighbourBefore(order, sid, plan);
		if (removed.has(sid)) {
			const entry = entries.find((other) => other.sid === sid);
			if (entry === undefined || plan.find(sid) !== undefined) {
				continue;
			}
			plan.run({
				op: "insert",
				sid,
				after,
				depth: entry.before_depth ?? 0,
				heading: entry.before_heading,
				text: entry.before_text ?? "",
				version: entry.before_version ?? 1,
			});
		} else if (plan.find(sid) !== undefined) {
			plan.run({ op: "move", sid, after });
		}
	}

	// Fields back to what they were.
	const back = fieldsBack(snap, fields);
	if (isRefusal(back)) {
		return back;
	}
	if (
		plan.ops.length === 0 &&
		back.fields === undefined &&
		back.rename === undefined
	) {
		return refuse(
			`Change ${row.id} has nothing left to undo.`,
			"The note already reads as it did before that change.",
		);
	}
	return {
		ops: plan.ops,
		fields: back.fields,
		rename: back.rename,
		undoes: row.id,
	};
}

/** The section before `sid` in `order` that is in the plan now, or null for the start. */
function neighbourBefore(
	order: string[],
	sid: string,
	plan: Planner,
): string | null {
	const at = order.indexOf(sid);
	for (let i = at - 1; i >= 0; i--) {
		if (plan.find(order[i]) !== undefined) {
			return order[i];
		}
	}
	return null;
}

/** The fields a change set, put back to what it replaced. */
function fieldsBack(
	snap: Snapshot,
	changed: Array<{ field: string; before: string | null }>,
): { fields?: NonNullable<Build["fields"]>; rename?: string } | Refusal {
	if (changed.length === 0) {
		return {};
	}
	const out: NonNullable<Build["fields"]> = {};
	let extra: Record<string, unknown> | undefined;
	let rename: string | undefined;
	for (const entry of changed) {
		const before: unknown =
			entry.before === null ? null : JSON.parse(entry.before);
		switch (entry.field) {
			case "name":
				rename = String(before);
				break;
			case "stale_after":
				out.staleAfter = before as string | null;
				break;
			case "archived":
				out.archived = before === true;
				break;
			case "type":
				out.type = String(before);
				break;
			case "title":
			case "description":
			case "status":
				out[entry.field] = before as string | null;
				break;
			case "tags":
				out.tags = before as string[];
				break;
			case "sources":
				out.sources = before as NoteFields["sources"];
				break;
			default:
				if (entry.field.startsWith("fields.")) {
					extra ??= { ...snap.fields.extra };
					const key = entry.field.slice("fields.".length);
					if (before === null || before === undefined) {
						delete extra[key];
					} else {
						extra[key] = before;
					}
				}
		}
	}
	if (extra !== undefined) {
		out.extra = extra;
	}
	return { fields: out, rename };
}

// ---------------------------------------------------------------------------
// a note back to a version

async function revertNote(
	ctx: WriteContext,
	asked: string,
	version: number,
	input: RevertInput,
): Promise<Written | Refusal> {
	const { db } = ctx;
	const found = resolveNote(db, asked);
	if (isRefusal(found)) {
		return found;
	}
	return commit(
		ctx,
		found.id,
		"revert",
		{
			reason: input.reason ?? `put back as at version ${version}`,
			by: input.by,
		},
		(snap) => {
			if (
				!Number.isInteger(version) ||
				version < 1 ||
				version > snap.concept.version
			) {
				return refuse(
					`${snap.name} has no version ${version}; its versions run from 1 to ${snap.concept.version}.`,
					"Use history with the note's name to see its versions.",
				);
			}
			if (version === snap.concept.version) {
				return {
					ops: [],
					skip: `${snap.name} is already at version ${version}.`,
				};
			}
			const target = rewind(db, found.id, currentState(db, found.id), version);
			const plan = new Planner(
				snap.name,
				snap.sections,
				snap.concept.next_section,
			);
			const wanted = target.sections.map((section) => section.sid);

			for (const section of snap.sections) {
				if (!wanted.includes(section.sid)) {
					plan.run({ op: "remove", sid: section.sid });
				}
			}
			for (const section of target.sections) {
				const now = plan.find(section.sid);
				if (
					now !== undefined &&
					(now.text !== section.text ||
						now.heading !== section.heading ||
						now.depth !== section.depth)
				) {
					plan.run({
						op: "update",
						sid: section.sid,
						text: section.text,
						heading: section.heading,
						depth: section.depth,
					});
				}
			}
			wanted.forEach((sid, index) => {
				const section = target.sections[index];
				if (plan.find(sid) === undefined) {
					plan.run({
						op: "insert",
						sid,
						after: index === 0 ? null : wanted[index - 1],
						depth: section.depth,
						heading: section.heading,
						text: section.text,
						version: section.version,
					});
				}
			});
			wanted.forEach((sid, index) => {
				if (plan.work[index]?.sid !== sid) {
					plan.run({
						op: "move",
						sid,
						after: index === 0 ? null : wanted[index - 1],
					});
				}
			});

			const now = snap.fields;
			const fields: NonNullable<Build["fields"]> = {};
			if (target.type !== now.type) fields.type = target.type;
			if (target.title !== now.title) fields.title = target.title;
			if (target.description !== now.description)
				fields.description = target.description;
			if (target.status !== now.status) fields.status = target.status;
			if (target.staleAfter !== now.staleAfter)
				fields.staleAfter = target.staleAfter;
			if (JSON.stringify(target.tags) !== JSON.stringify(now.tags))
				fields.tags = target.tags;
			if (JSON.stringify(target.sources) !== JSON.stringify(now.sources)) {
				fields.sources = target.sources as NoteFields["sources"];
			}
			if (JSON.stringify(target.extra) !== JSON.stringify(now.extra))
				fields.extra = target.extra;
			if (target.archived !== (snap.concept.archived === 1))
				fields.archived = target.archived;

			let rename: string | undefined;
			if (target.name !== snap.name) {
				const holder = db
					.query<{ identifier: string }, [string, number]>(
						"SELECT identifier FROM concepts WHERE identifier = ? AND id <> ?",
					)
					.get(target.name, found.id);
				if (holder !== null) {
					return refuse(
						`${snap.name} was called ${target.name} at version ${version}, and another note has that name now.`,
						"Rename the other note first, or put back a later version.",
					);
				}
				rename = target.name;
			}
			const noFields = Object.keys(fields).length === 0;
			if (plan.ops.length === 0 && noFields && rename === undefined) {
				return {
					ops: [],
					skip: `${snap.name} already reads as it did at version ${version}.`,
				};
			}
			return { ops: plan.ops, fields: noFields ? undefined : fields, rename };
		},
	);
}
