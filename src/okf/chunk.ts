/**
 * Splitting a concept into retrievable passages.
 *
 * A search result should point at a section of a document rather than at the
 * file, so the body is cut at its markdown headings and each passage carries
 * the offsets needed to open the original file at that spot.
 *
 * The size rules, in the order they are applied:
 *
 * - sections shorter than {@link MIN_CHUNK_TOKENS} merge into the section
 *   that follows them, because a two-line section is not worth a result of
 *   its own;
 * - a section over {@link MAX_CHUNK_TOKENS} is split at paragraph boundaries
 *   with one paragraph of overlap, so a sentence's context is not lost at the
 *   seam;
 * - a fenced code block is one indivisible paragraph and is never split, even
 *   when it is over the cap on its own.
 */

/** Roughly four hundred tokens: the cap a chunk is split to stay under. */
export const MAX_CHUNK_TOKENS = 400;

/** Below this, a section is merged into the next rather than indexed alone. */
export const MIN_CHUNK_TOKENS = 25;

/** An overlapping paragraph longer than this is dropped rather than repeated. */
const MAX_OVERLAP_TOKENS = 100;

export interface Chunk {
	ordinal: number;
	/** The heading this passage sits under, or null above the first heading. */
	heading: string | null;
	/** The heading and its ancestors, `" > "` separated. */
	headingPath: string | null;
	/** The heading's level; 0 for a passage above the first heading. */
	depth: number;
	/** 1-based, inclusive. */
	startLine: number;
	/** 1-based, inclusive. */
	endLine: number;
	/** 0-based, into the original file. */
	startChar: number;
	/** 0-based, exclusive, into the original file. */
	endChar: number;
	/** The passage exactly as it appears in the file. */
	text: string;
	/** The text that gets indexed: title and heading path, then the passage. */
	indexedText: string;
	tokenEstimate: number;
}

export interface ChunkOptions {
	/** The concept body, with the frontmatter already removed. */
	body: string;
	/** The body's 0-based character offset into the file. */
	bodyCharOffset: number;
	/** The body's 1-based starting line in the file. */
	bodyStartLine: number;
	/** The concept title, prepended to every indexed passage. */
	title: string | null;
}

/**
 * One token is about four characters. Good enough to size a chunk: the real
 * tokenizer belongs to the embedding model, and this only has to keep a
 * passage comfortably inside its context.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Split a concept body into chunks. */
export function chunkConcept(options: ChunkOptions): Chunk[] {
	const sections = mergeShortSections(splitAtHeadings(options));

	const chunks: Chunk[] = [];
	for (const section of sections) {
		for (const piece of splitOversize(section)) {
			chunks.push(finish(piece, chunks.length, options.title));
		}
	}
	return chunks;
}

/** A passage before its ordinal and indexed text are settled. */
interface Section {
	heading: string | null;
	headingPath: string | null;
	depth: number;
	startLine: number;
	endLine: number;
	startChar: number;
	endChar: number;
	text: string;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * Cut the body at its ATX headings.
 *
 * A heading inside a fenced code block is a comment, not a heading, so the
 * fence state is tracked while scanning.
 */
function splitAtHeadings(options: ChunkOptions): Section[] {
	const lines = options.body.split("\n");
	const sections: Section[] = [];

	/** The open heading at each level, so a heading path can be built. */
	const ancestors: string[] = [];
	let fence: string | null = null;

	let current: string[] = [];
	let currentHeading: string | null = null;
	let currentPath: string | null = null;
	let currentDepth = 0;
	let currentStartLine = options.bodyStartLine;
	let currentStartChar = options.bodyCharOffset;

	let charCursor = options.bodyCharOffset;

	const flush = (endLine: number, endChar: number): void => {
		const section = trimBlankEdges({
			heading: currentHeading,
			headingPath: currentPath,
			depth: currentDepth,
			startLine: currentStartLine,
			endLine,
			startChar: currentStartChar,
			endChar,
			text: current.join("\n"),
		});
		if (section !== null) {
			sections.push(section);
		}
		current = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = options.bodyStartLine + i;
		const lineStartChar = charCursor;
		charCursor += line.length + 1;

		const fenceMatch = /^[ \t]{0,3}(```+|~~~+)/.exec(line);
		if (fenceMatch !== null) {
			if (fence === null) {
				fence = fenceMatch[1][0];
			} else if (fenceMatch[1][0] === fence) {
				fence = null;
			}
			current.push(line);
			continue;
		}

		const headingMatch = fence === null ? HEADING.exec(line) : null;
		if (headingMatch === null) {
			current.push(line);
			continue;
		}

		// The end offset a flush takes is the newline that terminates the last
		// buffered line, which is the character before this heading starts.
		flush(lineNumber - 1, lineStartChar - 1);

		const depth = headingMatch[1].length;
		const heading = headingMatch[2];
		ancestors.length = Math.min(ancestors.length, depth - 1);
		ancestors[depth - 1] = heading;

		currentHeading = heading;
		currentPath = ancestors.filter((name) => name !== undefined).join(" > ");
		currentDepth = depth;
		currentStartLine = lineNumber;
		currentStartChar = lineStartChar;
		current.push(line);
	}

	flush(options.bodyStartLine + lines.length - 1, charCursor - 1);
	return sections;
}

/**
 * Drop the blank lines around a section, adjusting its offsets to match, and
 * discard it entirely when nothing but blank lines is left.
 */
function trimBlankEdges(section: Section): Section | null {
	const lines = section.text.split("\n");

	let first = 0;
	while (first < lines.length && lines[first].trim() === "") {
		first++;
	}
	let last = lines.length - 1;
	while (last >= first && lines[last].trim() === "") {
		last--;
	}
	if (first > last) {
		return null;
	}

	let leading = 0;
	for (let i = 0; i < first; i++) {
		leading += lines[i].length + 1;
	}
	let trailing = 0;
	for (let i = last + 1; i < lines.length; i++) {
		trailing += lines[i].length + 1;
	}

	return {
		...section,
		startLine: section.startLine + first,
		endLine: section.startLine + last,
		startChar: section.startChar + leading,
		endChar: section.endChar - trailing,
		text: lines.slice(first, last + 1).join("\n"),
	};
}

/**
 * Fold a section shorter than the minimum into the one after it.
 *
 * The merged passage keeps the earlier section's heading, because that is the
 * heading a reader arriving at those offsets will see. A short final section
 * has nothing to merge into and is kept as it is.
 */
function mergeShortSections(sections: Section[]): Section[] {
	const merged: Section[] = [];

	for (let i = sections.length - 1; i >= 0; i--) {
		const section = sections[i];
		const next = merged[0];

		if (
			next !== undefined &&
			estimateTokens(section.text) < MIN_CHUNK_TOKENS &&
			next.startChar >= section.endChar
		) {
			merged[0] = {
				heading: section.heading,
				headingPath: section.headingPath,
				depth: section.depth,
				startLine: section.startLine,
				endLine: next.endLine,
				startChar: section.startChar,
				endChar: next.endChar,
				// The gap between the two sections is blank lines only, so
				// joining on a blank line reproduces the file closely enough
				// for the text to read naturally.
				text: `${section.text}\n\n${next.text}`,
			};
			continue;
		}

		merged.unshift(section);
	}

	return merged;
}

/**
 * Split an oversize section at paragraph boundaries, repeating one paragraph
 * of context across each seam. A single paragraph over the cap — a long fenced
 * code block, say — is emitted whole rather than cut.
 */
function splitOversize(section: Section): Section[] {
	if (estimateTokens(section.text) <= MAX_CHUNK_TOKENS) {
		return [section];
	}

	const paragraphs = splitParagraphs(section);
	const pieces: Section[] = [];
	let current: Paragraph[] = [];

	const flush = (): void => {
		if (current.length === 0) {
			return;
		}
		const first = current[0];
		const last = current[current.length - 1];
		pieces.push({
			...section,
			startLine: first.startLine,
			endLine: last.endLine,
			startChar: first.startChar,
			endChar: last.endChar,
			text: current.map((paragraph) => paragraph.text).join("\n\n"),
		});
		const overlap = current[current.length - 1];
		current =
			estimateTokens(overlap.text) <= MAX_OVERLAP_TOKENS ? [overlap] : [];
	};

	for (const paragraph of paragraphs) {
		const projected = [...current, paragraph]
			.map((entry) => entry.text)
			.join("\n\n");
		if (current.length > 0 && estimateTokens(projected) > MAX_CHUNK_TOKENS) {
			flush();
			// The overlap paragraph may already fill the chunk on its own.
			if (
				current.length > 0 &&
				estimateTokens(`${current[0].text}\n\n${paragraph.text}`) >
					MAX_CHUNK_TOKENS
			) {
				current = [];
			}
		}
		current.push(paragraph);
	}

	// The final flush must not leave the trailing overlap behind as a piece of
	// its own, so it is emitted directly.
	if (current.length > 0) {
		const first = current[0];
		const last = current[current.length - 1];
		pieces.push({
			...section,
			startLine: first.startLine,
			endLine: last.endLine,
			startChar: first.startChar,
			endChar: last.endChar,
			text: current.map((paragraph) => paragraph.text).join("\n\n"),
		});
	}

	return pieces;
}

interface Paragraph {
	startLine: number;
	endLine: number;
	startChar: number;
	endChar: number;
	text: string;
}

/**
 * Break a section into paragraphs on blank lines, treating a fenced code
 * block as one paragraph however many blank lines it contains.
 */
function splitParagraphs(section: Section): Paragraph[] {
	const lines = section.text.split("\n");
	const paragraphs: Paragraph[] = [];

	let fence: string | null = null;
	let buffer: string[] = [];
	let startIndex = 0;
	let startChar = section.startChar;
	let charCursor = section.startChar;

	const flush = (endIndex: number, endChar: number): void => {
		if (buffer.length === 0) {
			return;
		}
		paragraphs.push({
			startLine: section.startLine + startIndex,
			endLine: section.startLine + endIndex,
			startChar,
			endChar,
			text: buffer.join("\n"),
		});
		buffer = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineStartChar = charCursor;
		charCursor += line.length + 1;

		const fenceMatch = /^[ \t]{0,3}(```+|~~~+)/.exec(line);
		if (fenceMatch !== null) {
			if (fence === null) {
				if (buffer.length === 0) {
					startIndex = i;
					startChar = lineStartChar;
				}
				fence = fenceMatch[1][0];
			} else if (fenceMatch[1][0] === fence) {
				fence = null;
			}
			buffer.push(line);
			continue;
		}

		if (fence === null && line.trim() === "") {
			flush(i - 1, lineStartChar - 1);
			continue;
		}

		if (buffer.length === 0) {
			startIndex = i;
			startChar = lineStartChar;
		}
		buffer.push(line);
	}

	flush(lines.length - 1, section.endChar);
	return paragraphs;
}

/** Settle a section into a chunk: its ordinal and the text that is indexed. */
function finish(
	section: Section,
	ordinal: number,
	title: string | null,
): Chunk {
	const path = section.headingPath ?? "";
	// A document whose first heading repeats its title is the common case, so
	// the two are not printed twice.
	const parts =
		title !== null && title !== "" && !path.startsWith(title)
			? [title, path]
			: [path === "" ? title : path];
	const prefix = parts
		.filter((part): part is string => part !== null && part !== "")
		.join(" > ");
	const indexedText =
		prefix === "" ? section.text : `${prefix}\n\n${section.text}`;

	return {
		ordinal,
		heading: section.heading,
		headingPath: section.headingPath === "" ? null : section.headingPath,
		depth: section.depth,
		startLine: section.startLine,
		endLine: section.endLine,
		startChar: section.startChar,
		endChar: section.endChar,
		text: section.text,
		indexedText,
		tokenEstimate: estimateTokens(indexedText),
	};
}
