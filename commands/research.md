---
description: Research a topic - searches existing docs, asks before new research
argument-hint: topic-query
model: sonnet
---

Research the topic "$ARGUMENTS": search what is already indexed, and only then
write something new.

## Where documents live

All documents live in the Lattice bundle, `~/.lattice/docs/` (or `$LATTICE_HOME/docs`
when that is set). Never write research into a project-local `docs/` directory.

| Path | Purpose |
|------|---------|
| `~/.lattice/docs/` | The bundle root |
| `~/.lattice/docs/{topic}/` | A topic directory |
| `~/.lattice/docs/{topic}/index.md` | The topic index — a reserved name, never indexed as a concept |
| `~/.lattice/docs/{topic}/*.md` | The concepts: one document per piece of research |

## Process

### Step 1: Search what is already indexed

Search first, machine-readably, so nothing is inferred from rendered text:

```bash
lattice search "$ARGUMENTS" --json
```

The JSON carries:

- `hits[]` — each with `path`, `identifier`, `title`, `type`, `status`, `trust`,
  `stale`, `score`, and `chunks[]` (the matching passages, with `headingPath`,
  `startLine`/`endLine` and a `snippet`). A hit carrying `expanded: true` and a
  `via` was reached by a link or a directory sibling, not by matching — treat it
  as a lead, not an answer.
- `degraded` and `degradedReason` — `true` means the semantic leg could not run
  and the answer came from keywords alone. Say so to the user; do not silently
  treat a keyword-only result as exhaustive.

Narrow when it helps: `--type Research`, `--tag <tag>`, `--dir <topic>`,
`--limit n`. Use `--no-expand` when you want only documents that matched.

Do not read a score as a percentage of relevance. Scores are only comparable
within one result set. Open the documents behind the top hits and judge from
their text.

### Step 2: Present what exists

Summarise, with paths:

- Which documents already cover the topic, and which passages (`headingPath`,
  line range).
- What they do not cover — the gap new research would fill.
- Whether the search was degraded.

If a hit is marked `stale`, say so: it is past its `stale_after` date.

### Step 3: Ask before researching

Use AskUserQuestion:

- **"Should I perform new research on this topic?"**
  - Yes — research and write a new document
  - Yes — research and extend an existing document
  - No — the existing research is enough

If **No**, stop here.

### Step 4: Research

Use WebSearch and any other sources available. Focus on the gap identified in
step 2 rather than restating what is already indexed. Keep every URL you use —
they become the document's `sources`.

### Step 5: Choose the topic directory and filename

**Topic directory** — reuse an existing `~/.lattice/docs/{topic}/` when one fits
(`lattice search "$ARGUMENTS" --json` already told you which directories hold
related work); otherwise derive a new kebab-case name.

**Filename** — kebab-case, 2–4 words, naming the specific focus. Never
`notes.md` or `research.md`.

| Query | Topic dir | Document |
|-------|-----------|----------|
| "tesla model s value retention" | `tesla-model-s/` | `value-retention.md` |
| "bun vs node performance" | `bun-nodejs/` | `performance-comparison.md` |
| "graphql authentication patterns" | `graphql/` | `authentication-patterns.md` |

### Step 6: Write the document

Every document is an OKF concept, and its frontmatter is not optional: `type` is
what makes the file conforming, and a file without it is indexed but reported by
`lattice status` as a frontmatter problem.

`~/.lattice/docs/{topic}/{filename}.md`:

```markdown
---
type: Research
title: Value retention
description: How well the Model S holds its resale value.
status: draft
tags: [tesla, resale]
generated: { by: agent:claude-code/research, at: 2026-09-20T00:00:00Z }
sources:
  - ../concepts/users.md
  - https://example.com/depreciation
---

# Value retention

## Key findings

Depreciation flattens after the fourth year.

## [Content sections as needed]

## Sources

1. [Depreciation study](https://example.com/depreciation)
```

Field by field:

| Field | Rule |
|-------|------|
| `type` | Required. `Research` for a research document; reuse whatever type a topic already uses. |
| `title` | Required. Human-readable, the document's own name. |
| `description` | Required. One sentence on what the document answers — it is indexed, so it is how the document is found. |
| `status` | `draft`, `stable` or `deprecated`. New research is `draft`. |
| `tags` | A list. Topic and facet, lowercase kebab-case. |
| `generated` | Provenance: `by` (`agent:claude-code/research`) and `at` (the UTC instant, ISO 8601). |
| `sources` | What the research drew on. A bundle-relative path becomes a `cited` edge in the graph; a URL is kept as a citation and is not an edge. |

Cite the same URLs again as markdown links in a `## Sources` section, so a
reader of the rendered document can follow them.

### Step 7: Write or update the topic index

`index.md` is OKF's reserved index name. It is navigation, not knowledge, so it
is never indexed as a concept — which is exactly why it may stay a plain list.

For a **new** topic, create `~/.lattice/docs/{topic}/index.md`:

```markdown
# {Topic Title}

Brief description of what this topic covers.

## Documents

| Document | Description |
|----------|-------------|
| [{Title}](./{filename}.md) | Brief description |

## Related

- [Related topic](../related-topic/index.md)
```

For an **existing** topic, add a row to its `index.md` table.

### Step 8: Sync

```bash
lattice sync
```

This indexes the document, chunks it at its headings, extracts the links and
`sources:` citations, and embeds whatever has no vector yet.

Then verify, through the CLI rather than by assumption:

```bash
lattice status                                   # frontmatter problems, if any
lattice rels {topic}/{filename}.md               # links, backlinks, siblings, unresolved
lattice search "$ARGUMENTS" --json               # the new document should now be a hit
```

If `lattice status` reports a frontmatter problem for the new file, fix the
frontmatter and sync again.

### Step 9: Confirm

Tell the user:

- What the search found before the research, and whether it was degraded
- The topic directory and the document path
- That the index was updated
- What `lattice rels` reports the document is connected to, including anything
  still unresolved

## Notes

- One document per piece of research; `index.md` stays a navigation index.
- kebab-case for every directory and filename.
- Every document has `type`, `title`, `description`, `tags`, `generated` and
  `sources`.
- An unresolved link is not a failure: it names a document that has not been
  written yet, and writing it repairs the edge on the next sync.

## File structure

```
~/.lattice/docs/{topic}/
├── index.md               # Reserved: the topic index, not a concept
├── {research-1}.md        # A conforming OKF concept
└── {research-2}.md
```
