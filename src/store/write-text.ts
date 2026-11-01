/**
 * The writes that change a note's text: edit, add, remove and move a section,
 * and append a finding. The shared machinery (snapshots, guards, the commit) is
 * in `write.ts`.
 */

import { isRefusal, type Refusal, resolveNote } from "./read.js";
import { directoryOf } from "./store.js";
import {
	type Build,
	commit,
	finished,
	noSection,
	Planner,
	refuse,
	type Snapshot,
	staleSection,
	type WriteContext,
	type Written,
} from "./write.js";
import { sourceEntry } from "./write-note.js";

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
		return finished(plan);
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
		const stale = staleSection(snap, item.section, item.version);
		if (stale !== undefined) {
			return stale;
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
		return finished(plan);
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
	/** The section's version the caller read; refused if it has changed since. */
	version?: number;
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
		if (input.version !== undefined) {
			const stale = staleSection(snap, input.section, input.version);
			if (stale !== undefined) {
				return stale;
			}
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
		return finished(plan, {
			info:
				input.with_subsections !== true && nested > 0
					? `${nested} nested sections stay; pass with_subsections to remove them too.`
					: undefined,
		});
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
		return finished(plan);
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
		return finished(plan, { fields, info });
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
