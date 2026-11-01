/**
 * A note's body as sections.
 *
 * A section's text runs from its heading line to the next heading line at any
 * depth, heading line included. Joined in order the sections are the body
 * exactly, which is what lets the import prove it lost nothing. A heading
 * inside a fenced code block is not a heading; `readLines` decides that, as it
 * does for the chunker and the link reader.
 */

import { readLines } from "../sync/lines.js";

export interface SectionText {
	/** The heading's words, or null for text that sits above the first heading. */
	heading: string | null;
	/** 1 to 6, or 0 for text above the first heading. */
	depth: number;
	text: string;
}

/**
 * Split a body into sections.
 *
 * Text above the first heading is a section of its own when it holds anything
 * but whitespace; otherwise it belongs to the first heading's section, so a
 * note that opens with a blank line and its title has the title as its first
 * section. A body with no heading at all is one section.
 */
export function splitSections(body: string): SectionText[] {
	if (body === "") {
		return [];
	}

	const starts: Array<{ at: number; heading: string; depth: number }> = [];
	for (const line of readLines(body)) {
		if (line.heading !== undefined) {
			starts.push({
				at: line.start,
				heading: line.heading.text,
				depth: line.heading.depth,
			});
		}
	}

	if (starts.length === 0) {
		return [{ heading: null, depth: 0, text: body }];
	}

	const sections: SectionText[] = [];
	const first = starts[0].at;
	if (body.slice(0, first).trim() !== "") {
		sections.push({ heading: null, depth: 0, text: body.slice(0, first) });
	}

	starts.forEach((start, index) => {
		// The first heading's section reaches back to the top of the body when
		// what sits above it is only whitespace.
		const from = index === 0 && sections.length === 0 ? 0 : start.at;
		const to = index + 1 < starts.length ? starts[index + 1].at : body.length;
		sections.push({
			heading: start.heading,
			depth: start.depth,
			text: body.slice(from, to),
		});
	});

	return sections;
}
