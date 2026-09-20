/**
 * The one piece of markdown both the chunker and the link reader need: which
 * lines are inside a fenced code block.
 *
 * Inside a fence a `#` is a comment rather than a heading, and a link is a
 * sample rather than a claim — so both callers depend on tracking fences the
 * same way, and there is one place that does it.
 */

/** A fence opener or closer, indented by up to three spaces. */
const FENCE = /^\s{0,3}(```+|~~~+)/;

export interface FencedLine {
	text: string;
	/** Offset of the line's first character within the text scanned. */
	start: number;
	/** Offset just past the line's newline, or the end of the text. */
	end: number;
	/** 1-based line number. */
	number: number;
	/** Inside a fenced code block. The fence's own delimiters count as inside. */
	fenced: boolean;
}

/**
 * Split text into lines, marking the ones inside a fenced code block.
 *
 * A fence closes only on a run of the same character at least as long as the
 * one that opened it, which is what lets a ```` ``` ```` sit inside a ````` ```` ````` block.
 */
export function readFencedLines(text: string): FencedLine[] {
	const lines: FencedLine[] = [];
	let start = 0;
	let number = 0;
	let fence: string | undefined;

	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const hasNewline = newline !== -1;
		const end = hasNewline ? newline + 1 : text.length;
		const content = text.slice(start, hasNewline ? newline : text.length);
		number++;

		const delimiter = FENCE.exec(content);
		const open = fence;
		const inFence = open !== undefined;
		if (open !== undefined) {
			const closes =
				delimiter !== null &&
				delimiter[1][0] === open[0] &&
				delimiter[1].length >= open.length;
			if (closes) {
				fence = undefined;
			}
		} else if (delimiter !== null) {
			fence = delimiter[1];
		}

		// A line closing a fence still belongs to the code block; a line opening
		// one does too. `inFence || delimiter` covers both.
		lines.push({
			text: content,
			start,
			end,
			number,
			fenced: inFence || delimiter !== null,
		});

		if (!hasNewline) {
			break;
		}
		start = end;
	}

	return lines;
}
