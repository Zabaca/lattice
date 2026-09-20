/**
 * Reading an OKF concept out of a markdown file.
 *
 * OKF conformance is deliberately permissive: a file whose frontmatter is
 * missing, unparseable or incomplete is still a concept. The problem is
 * recorded and reported, never used as a reason to reject the file.
 */

import matter from "gray-matter";

/** Frontmatter fields promoted to their own column, and so not repeated in the JSON remainder. */
const PROMOTED = [
	"type",
	"title",
	"description",
	"status",
	"stale_after",
	"tags",
] as const;

export type Trust = "unverified" | "machine-confirmed" | "human-reviewed";

export interface OkfConcept {
	/** The markdown body with the frontmatter block removed. */
	body: string;
	/** Characters of the original file consumed before the body starts. */
	bodyOffset: number;
	/** Lines of the original file consumed before the body starts. */
	bodyLineOffset: number;
	type?: string;
	title?: string;
	description?: string;
	status?: string;
	staleAfter?: string;
	tags: string[];
	/**
	 * The citation entries, as written: a bare path or URL, or a record
	 * carrying one. They stay in `rest` too — no column is promoted for them.
	 */
	sources: Array<string | Record<string, unknown>>;
	trust: Trust;
	/** The frontmatter fields no column was promoted for. */
	rest: Record<string, unknown>;
	/** Why this file's frontmatter could not be read as OKF, when it could not. */
	problem?: string;
}

/** The opening delimiter, the YAML, and the closing delimiter's line. */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parse one file's raw text.
 *
 * The frontmatter block is located here rather than taken from the YAML
 * library, because `bodyOffset` and `bodyLineOffset` are what keep chunk
 * offsets pointing into the original file: everything downstream works on
 * `body` and adds them back.
 */
export function parseConcept(raw: string): OkfConcept {
	const block = FRONTMATTER.exec(raw);
	const bodyOffset = block === null ? 0 : block[0].length;
	const body = raw.slice(bodyOffset);
	const empty = {
		body,
		bodyOffset,
		bodyLineOffset: countLines(raw.slice(0, bodyOffset)),
		tags: [],
		sources: [],
		trust: "unverified" as const,
		rest: {},
	};

	if (block === null) {
		return { ...empty, problem: "no frontmatter" };
	}

	let data: Record<string, unknown>;
	try {
		data = normalizeDates(matter(raw).data) as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			...empty,
			problem: `frontmatter is not valid YAML: ${firstLine(message)}`,
		};
	}

	if (Object.keys(data).length === 0) {
		return { ...empty, problem: "frontmatter is empty" };
	}

	const rest: Record<string, unknown> = { ...data };
	for (const field of PROMOTED) {
		delete rest[field];
	}

	const type = asString(data.type);

	return {
		...empty,
		type,
		title: asString(data.title),
		description: asString(data.description),
		status: asString(data.status),
		staleAfter: asString(data.stale_after),
		tags: asTags(data.tags),
		sources: asSources(data.sources),
		trust: deriveTrust(data.verified),
		rest,
		problem: type === undefined ? "frontmatter has no `type`" : undefined,
	};
}

/**
 * Trust from the OKF verification records: none is unverified, any human
 * actor outranks the rest, and anything else was confirmed by a machine.
 */
export function deriveTrust(verified: unknown): Trust {
	const records =
		verified === undefined || verified === null
			? []
			: Array.isArray(verified)
				? verified
				: [verified];

	if (records.length === 0) {
		return "unverified";
	}

	const human = records.some((record) => {
		const by = asString((record as Record<string, unknown> | null)?.by);
		return by !== undefined && by.startsWith("human:");
	});

	return human ? "human-reviewed" : "machine-confirmed";
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	return value === undefined || value === null ? undefined : String(value);
}

function asTags(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	const tags = new Set<string>();
	for (const entry of value) {
		const tag = asString(entry)?.trim();
		if (tag) {
			tags.add(tag);
		}
	}
	return [...tags];
}

/**
 * Citations, kept in whichever of the two shapes the author used. A single
 * entry written without a list is one citation, not a mistake.
 */
function asSources(value: unknown): Array<string | Record<string, unknown>> {
	const entries = Array.isArray(value)
		? value
		: value === undefined || value === null
			? []
			: [value];

	const sources: Array<string | Record<string, unknown>> = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			sources.push(entry);
		} else if (entry !== null && typeof entry === "object") {
			sources.push(entry as Record<string, unknown>);
		}
	}
	return sources;
}

/**
 * js-yaml turns bare timestamps into Date objects. Frontmatter is stored and
 * compared as the author wrote it, so they go back to ISO strings.
 */
function normalizeDates(value: unknown): unknown {
	if (value instanceof Date) {
		return value.toISOString().replace(".000Z", "Z");
	}
	if (Array.isArray(value)) {
		return value.map(normalizeDates);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			out[key] = normalizeDates(entry);
		}
		return out;
	}
	return value;
}

function firstLine(message: string): string {
	return message.split("\n", 1)[0];
}

function countLines(text: string): number {
	let lines = 0;
	for (const character of text) {
		if (character === "\n") {
			lines++;
		}
	}
	return lines;
}
