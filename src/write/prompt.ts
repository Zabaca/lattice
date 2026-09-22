/**
 * What the writer is asked.
 *
 * The prompt is the research-jev skill's document rules, moved into the
 * command: the template and the field table are the skill's Step 7 word
 * for word, so a document the runner writes is the document a session
 * following the skill would have written. What is new is the material —
 * the passages the judge kept, and for an extension the document as it
 * stands — and the one rule the check enforces afterwards: `sources` may
 * hold only what the run actually read.
 */

import type { Candidate } from "../run/judge.js";

export type Decision = "answered" | "extend" | "new";

export interface WritePromptInput {
	topic: string;
	decision: Exclude<Decision, "answered">;
	/** The document being extended, frontmatter included. */
	existing?: string;
	/** What the judge kept from the web, in the order it was kept. */
	web: Candidate[];
	/** What the judge kept from the index. */
	index: Candidate[];
	/**
	 * Every `sources` entry the document may carry, as it should be written:
	 * a bundle path relative to the document, or a URL.
	 */
	allowedSources: string[];
	/**
	 * The hub the document belongs to, as a citation, when one was found.
	 * Without one the writer is asked to name the subject, and the command
	 * writes the hub.
	 */
	hub?: string;
}

/**
 * The line a draft ends with when it names its own hub:
 * `hub: <Name> — <one sentence>`, or `hub: <Name>` alone when no source the
 * run read describes the subject. The sentence is optional because requiring
 * it is what made a writer with nothing to go on invent one.
 */
export const HUB_TRAILER = /^hub:\s*(.+?)(?:\s+(?:—|--|-)\s+(.+?))?\s*$/;

/** The skill's document template and field rules, verbatim. */
const TEMPLATE = `\`~/.lattice/docs/research/{filename}.md\`:

\`\`\`markdown
---
type: Research
title: Tesla Model S value retention
description: How well the Model S holds its resale value.
status: draft
tags: [tesla, resale]
generated: { by: agent:claude-code/research, at: 2026-09-20T00:00:00Z }
sources:
  - ../topic/tesla-model-s.md
  - ../bigquery-table/users.md
  - https://example.com/depreciation
---

# Tesla Model S value retention

## Key findings

Depreciation flattens after the fourth year, later than the
[[tesla-model-3-value-retention]] curve, and the [[/topic/battery-degradation]]
schedule is the main driver.

## [Content sections as needed]

## Sources

1. [Depreciation study](https://example.com/depreciation)
\`\`\`

Field by field:

| Field | Rule |
|-------|------|
| \`type\` | Required. \`Research\` for findings, \`Topic\` for a hub. It decides the directory: a \`Research\` document in any directory but \`research/\` is reported by \`lattice status\`. |
| \`title\` | Required. Human-readable, the document's own name, carrying the subject. |
| \`description\` | Required. One sentence on what the document answers — it is indexed, so it is how the document is found. |
| \`status\` | \`draft\`, \`stable\` or \`deprecated\`. New research is \`draft\`. |
| \`tags\` | A list. Subject and facet, lowercase kebab-case. |
| \`generated\` | Provenance: \`by\` (\`agent:claude-code/research\`) and \`at\` (the UTC instant, ISO 8601). |
| \`sources\` | What the research drew on, as decided in Step 6. A bundle-relative path becomes a \`cited\` edge in the graph; a URL is kept as a citation and is not an edge. |

Cite the same URLs again as markdown links in a \`## Sources\` section, so a
reader of the rendered document can follow them. In the body, the wikilinks
from Step 6 stand where the bare names would have been.`;

const LINKING = `Connect the document to the graph. A document with no in-bundle links is a
leaf nobody can reach except by search, so the body must contain at least
one wikilink, and it is refused without one. Where the body refers to
something an indexed document already covers, write a wikilink instead of a
bare name: \`[[name]]\` for another document in \`research/\`,
\`[[/topic/name]]\` for a document of another type. Where it leans on a
concept nobody has written yet — a technology, a method, a library, an
organisation it keeps returning to — link it anyway as \`[[/{type}/{name}]]\`
(kebab-case, for example \`[[/tool/sqlite-fts5]]\` or \`[[/method/reciprocal-rank-fusion]]\`)
and leave it unresolved: an unresolved link is the graph's record that the
knowledge is wanted. The document's own subject is its hub, cited in
\`sources\`, so do not wikilink the subject itself under another type; link
the things the document says about it. Links inside fenced code blocks are
not edges. Do not put entities in frontmatter.`;

const NAME_HUB = `No topic hub exists yet for this subject. After the document, as its very
last line, name the subject it belongs under:

hub: <Subject name> — <one sentence describing the subject>

The subject is the thing the question is about (the tool, the method, the
system), broad enough that other research will share it: for a question
about how SQLite FTS5 ranks, the hub is \`SQLite FTS5\`, not the question.
The command writes the hub document from this line.

If none of the sources you were given says what the subject is, write the
name alone:

hub: <Subject name>

Do not describe a subject your sources do not describe. A missing sentence
is recorded as missing; a guess is indistinguishable from a fact once it is
written.`;

export function writePrompt(input: WritePromptInput): string {
	const parts: string[] = [];
	parts.push(
		input.decision === "new"
			? `Write a new OKF research document answering: "${input.topic}".`
			: `Extend the OKF research document below so that it answers: "${input.topic}". ` +
					"Keep everything it already says that is still right, keep its title and its existing sources, " +
					"and add what the new material adds. Return the whole document, not a diff.",
	);
	parts.push(
		"Return the complete document and nothing else: frontmatter between `---` lines, then the body. No code fence around it, no preamble, no commentary after it.",
	);
	if (input.existing !== undefined) {
		parts.push(`The document as it stands:\n\n${input.existing}`);
	}
	parts.push(
		`The material, kept by a judge as answering the question. Write from it; do not invent facts it does not support.`,
	);
	if (input.web.length > 0) {
		parts.push(
			`Web pages:\n\n${input.web.map((page) => `### ${page.title}\nURL: ${page.ref}\n\n${page.text}`).join("\n\n")}`,
		);
	}
	if (input.index.length > 0) {
		parts.push(
			`Indexed documents already in the bundle:\n\n${input.index.map((doc) => `### ${doc.title}\nPath: ${doc.ref}\n\n${doc.text}`).join("\n\n")}`,
		);
	}
	parts.push(
		`\`sources\` may contain only these entries, written exactly so; any other entry will be removed:\n${input.allowedSources.map((source) => `  - ${source}`).join("\n")}` +
			(input.hub === undefined
				? ""
				: `\nCite the topic hub \`${input.hub}\`: that is how the document declares which subject it belongs to.`),
	);
	parts.push(LINKING);
	parts.push(TEMPLATE);
	if (input.hub === undefined) {
		parts.push(NAME_HUB);
	}
	return parts.join("\n\n");
}

/** The prompt again, with why the last draft was refused, so the second try can fix it. */
export function retryPrompt(
	prompt: string,
	draft: string,
	problems: string[],
): string {
	return (
		`${prompt}\n\nYour previous draft was rejected:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
		`The rejected draft:\n\n${draft}\n\nReturn a corrected complete document.`
	);
}
