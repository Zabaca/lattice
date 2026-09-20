/**
 * Splitting a concept into retrievable passages.
 *
 * Markdown headings are the author's own outline, so they are the split
 * points. Everything else in here exists to stop a passage being useless:
 * one too large to embed, one too small to mean anything on its own, or a
 * code block torn in half.
 */

import { type FencedLine, readFencedLines } from "./markdown.js";
import { hashContent } from "./scan.js";

/** Roughly four hundred estimated tokens per chunk. */
const MAX_TOKENS = 400;
/** A section smaller than this says too little alone, and merges forward. */
const MIN_TOKENS = 40;
/** Carried from the end of one split piece into the next, so a sentence cut in two is still findable. */
const OVERLAP_TOKENS = 50;
/** Tokens per character, close enough for a size cap and far cheaper than a tokenizer. */
const CHARS_PER_TOKEN = 4;

export interface Chunk {
	ordinal: number;
	heading?: string;
	/** The headings above this passage, outermost first, joined by " > ". */
	headingPath: string;
	depth: number;
	/** 1-based, inclusive, into the original file. */
	startLine: number;
	endLine: number;
	/** 0-based, half-open, into the original file. */
	startChar: number;
	endChar: number;
	content: string;
	contentHash: string;
	tokenEstimate: number;
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * A line of the body, with the heading it declares. Inside a fenced block a
 * `#` is not a heading and a split is forbidden, so `fenced` decides both.
 */
interface Line extends FencedLine {
	heading?: { text: string; depth: number };
}

interface Section {
	heading?: string;
	headingPath: string;
	depth: number;
	lines: Line[];
}

/**
 * Chunk a document body.
 *
 * `charOffset` and `lineOffset` are what the frontmatter consumed, so the
 * offsets returned address the original file rather than the body.
 */
export function chunkDocument(
	body: string,
	charOffset: number,
	lineOffset: number,
): Chunk[] {
	const sections = mergeShortSections(splitAtHeadings(readLines(body)));
	const chunks: Chunk[] = [];

	for (const section of sections) {
		for (const lines of splitOversize(section)) {
			const chunk = toChunk(
				section,
				lines,
				chunks.length,
				charOffset,
				lineOffset,
			);
			if (chunk !== undefined) {
				chunks.push(chunk);
			}
		}
	}

	return chunks;
}

function readLines(body: string): Line[] {
	return readFencedLines(body).map((line) => ({
		...line,
		heading: line.fenced ? undefined : readHeading(line.text),
	}));
}

function readHeading(text: string): Line["heading"] {
	const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
	if (match === null) {
		return undefined;
	}
	return { text: match[2], depth: match[1].length };
}

function splitAtHeadings(lines: Line[]): Section[] {
	const sections: Section[] = [];
	const ancestors: Array<{ text: string; depth: number }> = [];
	let current: Section | undefined;

	for (const line of lines) {
		if (line.heading !== undefined) {
			while (
				ancestors.length > 0 &&
				ancestors[ancestors.length - 1].depth >= line.heading.depth
			) {
				ancestors.pop();
			}
			ancestors.push(line.heading);
			current = {
				heading: line.heading.text,
				headingPath: ancestors.map((entry) => entry.text).join(" > "),
				depth: line.heading.depth,
				lines: [line],
			};
			sections.push(current);
			continue;
		}

		if (current === undefined) {
			current = { headingPath: "", depth: 0, lines: [] };
			sections.push(current);
		}
		current.lines.push(line);
	}

	return sections;
}

/**
 * Fold a section too small to stand alone into the one after it. The merged
 * chunk keeps the first section's heading, because that is where its text
 * starts, and its offsets run from the first line to the last.
 */
function mergeShortSections(sections: Section[]): Section[] {
	const merged: Section[] = [];

	for (const section of sections) {
		// A document opening with a blank line has an empty preamble section; it
		// is nothing, so it must not swallow the first real heading.
		if (sectionText(section.lines) === "") {
			continue;
		}
		const previous = merged[merged.length - 1];
		if (previous !== undefined && sectionTokens(previous) < MIN_TOKENS) {
			previous.lines.push(...section.lines);
			continue;
		}
		merged.push({ ...section, lines: [...section.lines] });
	}

	return merged;
}

function sectionTokens(section: Section): number {
	return estimateTokens(sectionText(section.lines));
}

function sectionText(lines: Line[]): string {
	return lines
		.map((line) => line.text)
		.join("\n")
		.trim();
}

/**
 * Break a section over the cap at blank lines, carrying a little of the
 * previous piece into the next. A run of lines inside a fence is never a
 * break point, so a code block over the cap is emitted whole and oversize
 * rather than cut in half.
 */
function splitOversize(section: Section): Line[][] {
	if (sectionTokens(section) <= MAX_TOKENS) {
		return [section.lines];
	}

	const paragraphs = toParagraphs(section.lines);
	const pieces: Line[][] = [];
	let current: Line[] = [];
	/** How many of `current`'s leading lines were carried over as overlap. */
	let carried = 0;

	for (const paragraph of paragraphs) {
		const fits =
			estimateTokens(sectionText([...current, ...paragraph])) <= MAX_TOKENS;
		const worthCutting =
			current.length > carried &&
			estimateTokens(sectionText(current)) >= MIN_TOKENS;

		if (!fits && worthCutting) {
			pieces.push(current);
			const overlap = overlapFrom(current);
			current = [...overlap, ...paragraph];
			carried = overlap.length;
			continue;
		}
		// Nothing worth cutting yet — a heading on its own, or one paragraph
		// (a whole code fence, say) already over the cap. Oversize beats torn.
		current.push(...paragraph);
	}

	// A remainder that adds nothing but the overlap already in the last piece
	// would be a duplicate chunk.
	if (pieces.length === 0 || sectionText(current.slice(carried)) !== "") {
		pieces.push(current);
	}

	return pieces;
}

/** Lines grouped into paragraphs at blank lines, with fenced blocks kept intact. */
function toParagraphs(lines: Line[]): Line[][] {
	const paragraphs: Line[][] = [];
	let current: Line[] = [];

	for (const line of lines) {
		current.push(line);
		if (line.text.trim() === "" && !line.fenced && current.length > 0) {
			paragraphs.push(current);
			current = [];
		}
	}

	if (current.length > 0) {
		paragraphs.push(current);
	}

	return paragraphs;
}

/** The tail of a piece, up to the overlap budget, repeated at the head of the next. */
function overlapFrom(lines: Line[]): Line[] {
	const tail: Line[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const candidate = [lines[i], ...tail];
		if (estimateTokens(sectionText(candidate)) > OVERLAP_TOKENS) {
			break;
		}
		tail.unshift(lines[i]);
	}

	if (sectionText(tail) !== "") {
		return tail;
	}

	// One unwrapped paragraph can be longer than the whole budget. An overlap
	// slightly over budget is still an overlap; no overlap at all is a seam a
	// query can fall straight through.
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].text.trim() !== "") {
			return lines.slice(i);
		}
	}
	return tail;
}

function toChunk(
	section: Section,
	lines: Line[],
	ordinal: number,
	charOffset: number,
	lineOffset: number,
): Chunk | undefined {
	const content = sectionText(lines);
	if (content === "") {
		return undefined;
	}

	const first = lines[0];
	const last = lines[lines.length - 1];

	return {
		ordinal,
		heading: section.heading,
		headingPath: section.headingPath,
		depth: section.depth,
		startLine: lineOffset + first.number,
		endLine: lineOffset + last.number,
		startChar: charOffset + first.start,
		endChar: charOffset + last.end,
		content,
		contentHash: hashContent(content),
		tokenEstimate: estimateTokens(content),
	};
}
