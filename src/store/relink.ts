/**
 * Changing where a note's links point, in the text that wrote them.
 *
 * Two things need it: a note that moves to another folder (a new type) has
 * relative links that would then point somewhere else, and an export writes a
 * link to a renamed note with the name the note has now. Both keep what a link
 * says apart from its target: the words, the anchor, and whether the author
 * wrote an absolute target, a relative one, or one without the `.md`.
 */

import { posix } from "node:path";
import {
	type AuthoredLink,
	extractBodyLinks,
	isExternal,
} from "../markdown/links.js";

/**
 * `text` with the target of some of its links replaced. `decide` is given each
 * markdown link and wikilink (not those in code blocks) and returns the new
 * target as it should be written, or undefined to leave the link alone.
 * `dir` is the folder the text sits in, which relative targets resolve against.
 */
export function rewriteLinks(
	text: string,
	dir: string,
	decide: (link: AuthoredLink) => string | undefined,
): string {
	const edits: Array<{ at: number; length: number; replacement: string }> = [];
	for (const link of extractBodyLinks(text, dir)) {
		if (link.charOffset === undefined) {
			continue;
		}
		const replacement = decide(link);
		if (replacement === undefined || replacement === link.rawTarget) {
			continue;
		}
		// A markdown link's target follows `](`; a wikilink's follows `[[`.
		const from =
			link.kind === "markdown"
				? text.indexOf("](", link.charOffset) + 2
				: link.charOffset + 2;
		const at = text.indexOf(link.rawTarget, from);
		if (from < 2 || at === -1) {
			continue;
		}
		edits.push({ at, length: link.rawTarget.length, replacement });
	}

	let out = text;
	for (const edit of edits.sort((a, b) => b.at - a.at)) {
		out =
			out.slice(0, edit.at) +
			edit.replacement +
			out.slice(edit.at + edit.length);
	}
	return out;
}

/**
 * A target written the way `raw` was (absolute or relative, with or without
 * `.md`, with its anchor) but pointing at `path`, as seen from the folder
 * `dir`.
 */
export function writeTarget(
	raw: string,
	path: string,
	dir: string,
	anchor?: string,
): string {
	const keepsSuffix = /\.md(#|$)/.test(raw);
	const named = keepsSuffix ? path : path.replace(/\.md$/, "");
	const base = raw.startsWith("/")
		? `/${named}`
		: posix.relative(dir === "" ? "." : dir, named);
	return anchor === undefined || anchor === "" ? base : `${base}#${anchor}`;
}

/**
 * A citation (a `sources` entry) written for one folder, written for another
 * so it still points at the same note. Anything that is not a relative path to
 * a note is returned as it was.
 */
export function moveSource<T extends string | Record<string, unknown>>(
	source: T,
	from: string,
	to: string,
): T {
	if (typeof source !== "string") {
		return source;
	}
	if (isExternal(source) || source.startsWith("/") || source.trim() === "") {
		return source;
	}
	const target = posix.normalize(posix.join(from, source));
	if (target.startsWith("..")) {
		return source;
	}
	return posix.relative(to === "" ? "." : to, target) as T;
}
