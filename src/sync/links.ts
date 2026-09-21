/**
 * Finding the links an author wrote between documents.
 *
 * Only links that point at another markdown document inside the bundle are
 * edges. An external URL is somebody else's knowledge, a link inside a fenced
 * block is a code sample, and a bare `#anchor` is navigation within the page
 * the reader is already on — none of the three says anything about how the
 * bundle's documents relate, so none of them is recorded.
 *
 * This is a line scan rather than a markdown parse: sync runs over the whole
 * bundle on every invocation, and the shapes below are what authors actually
 * write.
 */

import { posix } from "node:path";
import { readLines } from "./lines.js";

export type LinkKind = "markdown" | "wikilink" | "source";

export interface AuthoredLink {
	kind: LinkKind;
	/** The target exactly as the author wrote it, anchor included. */
	rawTarget: string;
	/** The bundle-relative path the target resolves to, whether or not it exists. */
	targetPath: string;
	/** The `#fragment` without its `#`, when the author aimed at one. */
	anchor?: string;
	/** The anchor text of the link, or the citation's title. */
	text?: string;
	/** The sentence the link was written in. Absent for a frontmatter citation. */
	context?: string;
	/** Offset of the link within the original file, or undefined for frontmatter. */
	charOffset?: number;
}

/** `[text](target)`, with the leading `!` of an image left for the caller to reject. */
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g;
/** `[[target]]` or `[[target|text]]`. */
const WIKILINK = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;

/**
 * Every edge out of one document's body.
 *
 * `dir` is the source document's bundle-relative directory, because a relative
 * target is relative to the document that wrote it.
 */
export function extractBodyLinks(body: string, dir: string): AuthoredLink[] {
	const links: AuthoredLink[] = [];

	for (const line of readLines(body)) {
		if (line.fenced) {
			continue;
		}

		for (const match of line.text.matchAll(MARKDOWN_LINK)) {
			// An image embeds a picture; it does not cite a document.
			if (match[1] === "!") {
				continue;
			}
			const link = toLink("markdown", match[3], dir, match[2]);
			if (link !== undefined) {
				links.push(withContext(link, body, line.start + (match.index ?? 0)));
			}
		}

		for (const match of line.text.matchAll(WIKILINK)) {
			const link = toLink("wikilink", match[1], dir, match[2]);
			if (link !== undefined) {
				links.push(withContext(link, body, line.start + (match.index ?? 0)));
			}
		}
	}

	return links;
}

/**
 * The frontmatter citations that point inside the bundle. A citation is an
 * edge of its own kind, so provenance can be told apart from a body mention.
 */
export function extractSourceLinks(
	sources: ReadonlyArray<string | Record<string, unknown>>,
	dir: string,
): AuthoredLink[] {
	const links: AuthoredLink[] = [];

	for (const source of sources) {
		const raw =
			typeof source === "string"
				? source
				: firstString(source, ["path", "url", "href", "source"]);
		if (raw === undefined) {
			continue;
		}
		const link = toLink(
			"source",
			raw,
			dir,
			typeof source === "string"
				? undefined
				: firstString(source, ["title", "name"]),
		);
		if (link !== undefined) {
			links.push(link);
		}
	}

	return links;
}

/**
 * One candidate target, or undefined when it does not name a document in this
 * bundle.
 */
function toLink(
	kind: LinkKind,
	rawTarget: string,
	dir: string,
	text?: string,
): AuthoredLink | undefined {
	const raw = rawTarget.trim();
	if (raw === "" || isExternal(raw)) {
		return undefined;
	}

	const hash = raw.indexOf("#");
	const anchor = hash === -1 ? undefined : raw.slice(hash + 1).trim();
	const target = (hash === -1 ? raw : raw.slice(0, hash)).trim();

	// A bare `#anchor` points within the document the reader is already in.
	if (target === "") {
		return undefined;
	}

	const path = normalizeTarget(target, dir);
	if (path === undefined) {
		return undefined;
	}

	const trimmedText = text?.trim();
	return {
		kind,
		rawTarget: raw,
		targetPath: path,
		anchor: anchor === "" ? undefined : anchor,
		text: trimmedText === "" ? undefined : trimmedText,
	};
}

/** Anything addressed by scheme or authority belongs to someone else. */
function isExternal(raw: string): boolean {
	return raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw);
}

/**
 * A target as a bundle-relative path.
 *
 * Relative targets resolve against the writing document's directory — the way
 * the author's editor follows them. An extensionless target is an OKF
 * identifier, so it gets the suffix back. A target that climbs out of the
 * bundle, or names a file that is not markdown, is not a document here.
 */
export function normalizeTarget(
	target: string,
	dir: string,
): string | undefined {
	const decoded = decodeTarget(target);
	if (decoded.includes("\\")) {
		return undefined;
	}

	const extension = posix.extname(decoded);
	if (extension !== "" && extension.toLowerCase() !== ".md") {
		return undefined;
	}

	const withSuffix = extension === "" ? `${decoded}.md` : decoded;
	const absolute = withSuffix.startsWith("/");
	const joined = posix.normalize(
		absolute ? withSuffix.slice(1) : posix.join(dir, withSuffix),
	);

	return joined.startsWith("..") ? undefined : joined;
}

/** `%20` and friends: an author's spaces survive their editor's escaping. */
function decodeTarget(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

/**
 * The sentence the link sits in, so a backlink can be read without opening the
 * file. Bounded by the surrounding blank lines, then narrowed to the sentence
 * containing the link.
 */
function withContext(
	link: AuthoredLink,
	body: string,
	offset: number,
): AuthoredLink {
	const start = paragraphStart(body, offset);
	const end = paragraphEnd(body, offset);
	const paragraph = body.slice(start, end);
	const within = offset - start;

	let sentenceStart = 0;
	let sentenceEnd = paragraph.length;
	// A sentence ends at `.`, `!` or `?` followed by whitespace. The link's own
	// text may contain one, so boundaries inside `[...]` and `(...)` are skipped.
	for (const match of paragraph.matchAll(/[.!?](?=\s|$)/g)) {
		const boundary = (match.index ?? 0) + 1;
		if (insideLink(paragraph, match.index ?? 0)) {
			continue;
		}
		if (boundary <= within) {
			sentenceStart = boundary;
		} else {
			sentenceEnd = boundary;
			break;
		}
	}

	const context = collapse(paragraph.slice(sentenceStart, sentenceEnd));
	return {
		...link,
		context: context === "" ? undefined : context,
		charOffset: offset,
	};
}

/** Whether an offset falls inside a link's `[...]` text or `(...)` target. */
function insideLink(paragraph: string, offset: number): boolean {
	const open = Math.max(
		paragraph.lastIndexOf("[", offset),
		paragraph.lastIndexOf("(", offset),
	);
	if (open === -1) {
		return false;
	}
	const closer = paragraph[open] === "[" ? "]" : ")";
	const close = paragraph.indexOf(closer, open);
	return close > offset;
}

function paragraphStart(body: string, offset: number): number {
	const boundary = body.lastIndexOf("\n\n", offset);
	return boundary === -1 ? 0 : boundary + 2;
}

function paragraphEnd(body: string, offset: number): number {
	const boundary = body.indexOf("\n\n", offset);
	return boundary === -1 ? body.length : boundary;
}

/** Wrapped prose reads as one sentence, so its newlines become spaces. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function firstString(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") {
			return value.trim();
		}
	}
	return undefined;
}
