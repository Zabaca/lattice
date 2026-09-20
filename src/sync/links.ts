/**
 * Reading the links an author wrote.
 *
 * Only links that point at another document *inside the bundle* are edges.
 * An external URL says nothing about this knowledge base, and a link inside a
 * fenced block or a code span is a code sample rather than a claim — so
 * neither produces one.
 *
 * Extraction is deliberately textual, like the chunker: markdown here is the
 * author's plain text, not a document tree.
 */

import { posix } from "node:path";
import { readFencedLines } from "./markdown.js";

export type LinkKind = "markdown" | "wikilink" | "source";

export interface AuthoredLink {
	kind: LinkKind;
	/** The target exactly as the author wrote it, anchor included. */
	rawTarget: string;
	/** Where it points, resolved against the bundle root. */
	targetPath: string;
	/** The `#fragment` the author wrote, without its `#`. */
	anchor?: string;
	/** The link's visible text; a wikilink with no alias has none. */
	text?: string;
	/** The sentence the link sits in. Frontmatter sources have none. */
	context?: string;
	/**
	 * Where the link starts in the ORIGINAL file, so it can be attributed to
	 * the chunk holding it. Frontmatter sources have no offset.
	 */
	offset?: number;
}

/** `[text](target)`, with an optional `"title"` after the target. */
const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*([^()\s]*?)\s*(?:"[^"]*")?\s*\)/g;
/** `[[target]]` or `[[target|text]]`. */
const WIKILINK = /\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g;
/** A scheme (`https:`, `mailto:`) or a protocol-relative host. */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
/** The end of a sentence: terminal punctuation before whitespace. */
const SENTENCE_END = /[.!?](?=\s|$)/g;

/**
 * Every authored link in a document body.
 *
 * `charOffset` is what the frontmatter consumed, so the offsets returned
 * address the original file; `sourcePath` is the document's bundle-relative
 * path, which is what a relative target is resolved against.
 */
export function extractBodyLinks(
	body: string,
	charOffset: number,
	sourcePath: string,
): AuthoredLink[] {
	const code = codeMask(body);
	const dir = posix.dirname(sourcePath);
	const links: AuthoredLink[] = [];

	for (const match of body.matchAll(WIKILINK)) {
		const at = match.index;
		if (code[at]) {
			continue;
		}
		const link = toLink("wikilink", match[1], match[2], dir);
		if (link !== undefined) {
			links.push({
				...link,
				context: sentenceAround(body, at, at + match[0].length),
				offset: charOffset + at,
			});
		}
	}

	for (const match of body.matchAll(MARKDOWN_LINK)) {
		const at = match.index;
		// An image is not a link to a document, and `![alt](x)` would otherwise
		// match on the `[alt](x)` inside it.
		if (code[at] || body[at - 1] === "!") {
			continue;
		}
		const link = toLink("markdown", match[2], match[1], dir);
		if (link !== undefined) {
			links.push({
				...link,
				context: sentenceAround(body, at, at + match[0].length),
				offset: charOffset + at,
			});
		}
	}

	links.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
	return links;
}

/**
 * The cited sources in a document's frontmatter that point inside the bundle.
 *
 * The field is read permissively — a string, a list of strings, or a list of
 * objects carrying `path`, `url` or `ref` — because a source the author wrote
 * in an unexpected shape should be ignored, never a reason to fail the file.
 *
 * A source is cited by OKF identifier, which is a path from the bundle root,
 * so it is resolved from there rather than from the citing document.
 */
export function extractSourceLinks(
	frontmatter: Record<string, unknown>,
): AuthoredLink[] {
	const links: AuthoredLink[] = [];

	for (const entry of toArray(frontmatter.sources ?? frontmatter.source)) {
		const raw = sourceRef(entry);
		if (raw === undefined) {
			continue;
		}
		const link = toLink("source", raw, undefined, "");
		if (link !== undefined) {
			links.push(link);
		}
	}

	return links;
}

function toArray(value: unknown): unknown[] {
	if (value === undefined || value === null) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

/** The reference inside one `sources` entry, whatever shape it was written in. */
function sourceRef(entry: unknown): string | undefined {
	if (typeof entry === "string") {
		return entry;
	}
	if (entry === null || typeof entry !== "object") {
		return undefined;
	}
	const record = entry as Record<string, unknown>;
	for (const field of ["path", "url", "ref"]) {
		const value = record[field];
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

/** One link, or nothing when its target is not a document in this bundle. */
function toLink(
	kind: LinkKind,
	rawTarget: string,
	text: string | undefined,
	baseDir: string,
): AuthoredLink | undefined {
	const raw = rawTarget.trim();
	const resolved = resolveTarget(raw, baseDir);
	if (resolved === undefined) {
		return undefined;
	}
	const label = text?.trim();
	return {
		kind,
		rawTarget: raw,
		targetPath: resolved.targetPath,
		anchor: resolved.anchor,
		text: label === undefined || label === "" ? undefined : label,
	};
}

/**
 * Turn a target as written into a bundle-relative path.
 *
 * `baseDir` is the bundle-relative directory a relative target is read
 * against: the source document's own directory for a body link, and the
 * bundle root for a cited source, which OKF writes as an identifier.
 *
 * Returns nothing for an external URL, a bare `#anchor` (which addresses this
 * same document), and a target naming a file that is not markdown.
 */
export function resolveTarget(
	rawTarget: string,
	baseDir: string,
): { targetPath: string; anchor?: string } | undefined {
	// `<...>` is markdown's way of wrapping a target containing spaces.
	const unwrapped = rawTarget.replace(/^<(.*)>$/, "$1").trim();
	if (unwrapped === "" || EXTERNAL.test(unwrapped)) {
		return undefined;
	}

	const hash = unwrapped.indexOf("#");
	const anchor =
		hash === -1
			? undefined
			: decodePath(unwrapped.slice(hash + 1)) || undefined;
	const target = hash === -1 ? unwrapped : unwrapped.slice(0, hash);
	if (target === "") {
		return undefined;
	}

	const decoded = decodePath(target);
	const extension = posix.extname(decoded);
	if (extension !== "" && extension.toLowerCase() !== ".md") {
		return undefined;
	}
	const withSuffix = extension === "" ? `${decoded}.md` : decoded;

	// A leading slash means the bundle root, not the filesystem root.
	const base = withSuffix.startsWith("/")
		? withSuffix.slice(1)
		: posix.join(baseDir, withSuffix);

	const targetPath = posix.normalize(base).replace(/^\.\//, "");
	// A target that climbs out of the bundle names nothing this index can ever
	// hold, so it is not an edge — not even an unresolved one.
	if (targetPath === ".." || targetPath.startsWith("../")) {
		return undefined;
	}
	return { targetPath, anchor };
}

/** `%20` and friends, when the author wrote a link an editor had escaped. */
function decodePath(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * A mask marking every character that is inside a fenced block or a code
 * span, so a link in a code sample can be found and then ignored. Positions
 * are kept rather than the text rewritten, so offsets stay true.
 */
function codeMask(body: string): boolean[] {
	const mask = new Array<boolean>(body.length).fill(false);

	for (const line of readFencedLines(body)) {
		const end = line.start + line.text.length;
		if (line.fenced) {
			mask.fill(true, line.start, end);
		} else {
			maskCodeSpans(line.text, line.start, mask);
		}
	}

	return mask;
}

/** Backtick-delimited spans within one line; a run closes on a run of equal length. */
function maskCodeSpans(text: string, offset: number, mask: boolean[]): void {
	const runs = [...text.matchAll(/`+/g)];

	for (let i = 0; i < runs.length; i++) {
		const open = runs[i];
		const close = runs.find(
			(run, index) => index > i && run[0].length === open[0].length,
		);
		if (close === undefined) {
			continue;
		}
		mask.fill(
			true,
			offset + open.index,
			offset + close.index + close[0].length,
		);
		while (i + 1 < runs.length && runs[i + 1].index <= close.index) {
			i++;
		}
	}
}

/**
 * The sentence holding `[from, to)`.
 *
 * Sentences are bounded by terminal punctuation followed by whitespace, and
 * by the blank lines around the paragraph, so a link's own `file.md` is never
 * read as the end of a sentence.
 */
function sentenceAround(body: string, from: number, to: number): string {
	const paragraph = paragraphAround(body, from, to);
	const relative = from - paragraph.start;
	const text = paragraph.text;

	let start = 0;
	let end = text.length;
	for (const match of text.matchAll(SENTENCE_END)) {
		const boundary = match.index + 1;
		if (boundary <= relative) {
			start = boundary;
		} else if (boundary >= to - paragraph.start) {
			end = boundary;
			break;
		}
	}

	return collapse(text.slice(start, end));
}

/** The block of non-blank lines holding the link, with where it starts. */
function paragraphAround(
	body: string,
	from: number,
	to: number,
): { text: string; start: number } {
	let start = 0;
	let end = body.length;

	for (const match of body.matchAll(/\n[ \t]*\n/g)) {
		const breakEnd = match.index + match[0].length;
		if (breakEnd <= from) {
			start = breakEnd;
		} else if (match.index >= to) {
			end = match.index;
			break;
		}
	}

	return { text: body.slice(start, end), start };
}

/** Line breaks inside a sentence are wrapping, not meaning. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
