/**
 * Reading one OKF concept out of a markdown file.
 *
 * The specification requires a consumer to tolerate everything: a missing
 * frontmatter block, an unknown `type`, unknown keys, even YAML that does not
 * parse. So nothing here rejects a document — a document that cannot be read
 * is indexed with no type and an error the `status` command reports.
 */

import matter from "gray-matter";

/** The trust tiers OKF derives from a concept's verification records. */
export type TrustLevel = "unverified" | "machine-confirmed" | "human-reviewed";

/** The lifecycle states OKF defines. Absent means `stable`. */
export type ConceptStatus = "draft" | "stable" | "deprecated";

export interface ParsedConcept {
	title: string | null;
	type: string | null;
	description: string | null;
	status: ConceptStatus;
	staleAfter: string | null;
	trustLevel: TrustLevel;
	tags: string[];
	/** The whole parsed frontmatter map, unknown keys included. */
	frontmatter: Record<string, unknown> | null;
	/** Why the frontmatter could not be read, or null when it was fine. */
	frontmatterError: string | null;
	/** The body: everything after the frontmatter block. */
	body: string;
	/** The body's 0-based character offset into the file. */
	bodyCharOffset: number;
	/** The body's 1-based starting line in the file. */
	bodyStartLine: number;
}

const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set([
	"draft",
	"stable",
	"deprecated",
]);

/**
 * Parse a concept from the raw text of its file.
 *
 * `fallbackTitle` is used when the frontmatter carries no `title` and the body
 * opens with no heading — by convention, the filename without its suffix.
 */
export function parseConcept(
	text: string,
	fallbackTitle: string,
): ParsedConcept {
	const split = splitFrontmatter(text);

	let frontmatter: Record<string, unknown> | null = null;
	let frontmatterError: string | null = null;

	if (split.hasBlock) {
		try {
			const parsed = matter(text).data as Record<string, unknown>;
			frontmatter = normalizeDates(parsed) as Record<string, unknown>;
		} catch (error) {
			frontmatterError = error instanceof Error ? error.message : String(error);
		}
	} else {
		frontmatterError = "No frontmatter block";
	}

	const body = text.slice(split.bodyCharOffset);

	return {
		title:
			readString(frontmatter, "title") ?? firstHeading(body) ?? fallbackTitle,
		type: readString(frontmatter, "type"),
		description: readString(frontmatter, "description"),
		status: readStatus(frontmatter),
		staleAfter: readString(frontmatter, "stale_after"),
		trustLevel: deriveTrustLevel(frontmatter),
		tags: readTags(frontmatter),
		frontmatter,
		frontmatterError,
		body,
		bodyCharOffset: split.bodyCharOffset,
		bodyStartLine: split.bodyStartLine,
	};
}

/**
 * The OKF trust tiers: no `verified` key is unverified, a `human:` actor makes
 * it human-reviewed, and any other verifier makes it machine-confirmed. A bare
 * mapping counts as a one-element list, as the specification requires.
 */
export function deriveTrustLevel(
	frontmatter: Record<string, unknown> | null,
): TrustLevel {
	const verified = frontmatter?.verified;
	if (verified === undefined || verified === null) {
		return "unverified";
	}

	const records = Array.isArray(verified) ? verified : [verified];
	if (records.length === 0) {
		return "unverified";
	}

	for (const record of records) {
		if (record === null || typeof record !== "object") {
			continue;
		}
		const by = (record as Record<string, unknown>).by;
		if (typeof by === "string" && by.startsWith("human:")) {
			return "human-reviewed";
		}
	}

	return "machine-confirmed";
}

interface FrontmatterSplit {
	hasBlock: boolean;
	bodyCharOffset: number;
	bodyStartLine: number;
}

/**
 * Locate the body behind a leading `---` delimited frontmatter block.
 *
 * Offsets rather than content: the chunker needs to address the original file,
 * so it has to know how many characters and lines the block consumed.
 */
function splitFrontmatter(text: string): FrontmatterSplit {
	const opening = /^---[ \t]*\r?\n/.exec(text);
	if (opening === null) {
		return { hasBlock: false, bodyCharOffset: 0, bodyStartLine: 1 };
	}

	const closing = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(opening[0].length));
	if (closing === null) {
		// An unterminated block is not a block; the whole file is the body.
		return { hasBlock: false, bodyCharOffset: 0, bodyStartLine: 1 };
	}

	const bodyCharOffset = opening[0].length + closing.index + closing[0].length;
	const consumed = text.slice(0, bodyCharOffset);
	return {
		hasBlock: true,
		bodyCharOffset,
		bodyStartLine: countLines(consumed) + 1,
	};
}

function countLines(text: string): number {
	let lines = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			lines++;
		}
	}
	return lines;
}

/** The text of the body's first ATX heading, when it opens with one. */
function firstHeading(body: string): string | null {
	const match = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
	return match === null ? null : match[1];
}

function readString(
	frontmatter: Record<string, unknown> | null,
	key: string,
): string | null {
	const value = frontmatter?.[key];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed === "" ? null : trimmed;
	}
	return null;
}

function readStatus(
	frontmatter: Record<string, unknown> | null,
): ConceptStatus {
	const value = readString(frontmatter, "status")?.toLowerCase();
	// An unknown value is not an error under OKF, but it is not a lifecycle
	// state either, so it falls back to the default rather than being stored.
	return value !== undefined && LIFECYCLE_STATUSES.has(value)
		? (value as ConceptStatus)
		: "stable";
}

function readTags(frontmatter: Record<string, unknown> | null): string[] {
	const value = frontmatter?.tags;
	if (!Array.isArray(value)) {
		return [];
	}

	const tags = new Set<string>();
	for (const tag of value) {
		if (typeof tag === "string" && tag.trim() !== "") {
			tags.add(tag.trim());
		}
	}
	return [...tags];
}

/**
 * YAML turns a bare `2026-06-30` into a Date. Frontmatter is stored as JSON
 * and compared as text, so dates go back to strings before either happens.
 */
function normalizeDates(value: unknown): unknown {
	if (value instanceof Date) {
		// Back to the spec's own shape: a whole second keeps no milliseconds,
		// so `stale_after: 2026-09-23T00:00:00Z` survives a round trip.
		const iso = value.toISOString();
		return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeDates);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			out[key] = normalizeDates(child);
		}
		return out;
	}
	return value;
}
