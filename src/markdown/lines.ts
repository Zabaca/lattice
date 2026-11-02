/**
 * Reading a markdown body as lines, with fenced code blocks marked.
 *
 * Chunking and link extraction both need to know which lines are inside a
 * fence — one so it never splits a code block, the other so a code sample
 * cannot author an edge — and they must agree, so they read lines here.
 */

export interface Line {
	text: string;
	/** Offset of the line's first character within the body. */
	start: number;
	/** Offset just past the line's newline (or the end of the body). */
	end: number;
	/** 1-based line number within the body. */
	number: number;
	/** Inside a fenced code block, where a `#` is not a heading and a split is forbidden. */
	fenced: boolean;
	heading?: { text: string; depth: number };
}

export function readLines(body: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	let number = 0;
	let fence: string | undefined;

	while (start <= body.length) {
		const newline = body.indexOf("\n", start);
		const hasNewline = newline !== -1;
		const end = hasNewline ? newline + 1 : body.length;
		const text = body.slice(start, hasNewline ? newline : body.length);
		number++;

		const opener = /^\s{0,3}(```+|~~~+)/.exec(text);
		const open = fence;
		const inFence = open !== undefined;
		if (open !== undefined) {
			const closes =
				opener !== null &&
				opener[1][0] === open[0] &&
				opener[1].length >= open.length;
			if (closes) {
				fence = undefined;
			}
		} else if (opener !== null) {
			fence = opener[1];
		}

		// A line closing a fence still belongs to the code block; a line opening
		// one does too. `inFence || opener` covers both.
		const fenced = inFence || opener !== null;
		const heading = fenced ? undefined : readHeading(text);

		lines.push({ text, start, end, number, fenced, heading });

		if (!hasNewline) {
			break;
		}
		start = end;
	}

	return lines;
}

function readHeading(text: string): Line["heading"] {
	const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
	if (match === null) {
		return undefined;
	}
	return { text: match[2], depth: match[1].length };
}
