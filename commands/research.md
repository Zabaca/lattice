---
description: Research a topic - searches existing docs, asks before new research
argument-hint: topic-query
model: sonnet
---

Research the topic "$ARGUMENTS": search what is already written first, and only
then write something new.

## Configuration

**All documentation lives in `~/.lattice/docs/` — the OKF bundle Lattice indexes.**

| Path | Purpose |
|------|---------|
| `~/.lattice/docs/` | The bundle root (ALWAYS use this) |
| `~/.lattice/docs/{topic}/` | Topic directory |
| `~/.lattice/docs/{topic}/index.md` | Topic index — a reserved name, never indexed as a concept |
| `~/.lattice/docs/{topic}/*.md` | Research documents — one concept each |

**NEVER use a project-local `docs/` directory. ALWAYS use the absolute path `~/.lattice/docs/`.**

## Process

### Step 1: Search what already exists

Start with the machine-readable search, so the result is read rather than
eyeballed:

```bash
lattice search "$ARGUMENTS" --json --limit 10
```

The JSON carries:

| Field | Meaning |
|-------|---------|
| `hits[].path` | Bundle-relative path of the document — read this file |
| `hits[].title` | Its frontmatter title, or `null` |
| `hits[].score` | Fused rank; comparable within one result set only, never a percentage |
| `hits[].via` | Present when the hit is a neighbour reached by expansion, not a direct match |
| `hits[].chunks[]` | The matching passages: `headingPath`, `startLine`–`endLine`, `snippet` |
| `degraded` / `degradedReason` | `true` when the semantic leg could not run — the answer is keyword-only |

`hits: []` means nothing in the bundle covers this yet. It is not an error.
When `degraded` is `true`, say so: an exact term will still be found, a
paraphrase may not be.

Read the files behind the promising hits — the snippet is an excerpt, not the
answer. Narrow with `--type`, `--tag` or `--dir` when the bundle is large.

### Step 2: Present what you found

Summarize:

- Which documents already cover the topic, quoting the passages that matter
- What they do not cover — the actual gap
- Whether the search was degraded

### Step 3: Ask about new research

Use AskUserQuestion:

- **"Should I perform new research on this topic?"**
  - Yes, research and write a new document
  - Yes, research and update an existing document
  - No, what exists is enough

If **No** → done.

### Step 4: Perform the research

1. Use WebSearch for current information
2. Synthesize it, focusing on the gap identified in Step 2
3. Keep every URL you used — they become the document's `sources`

### Step 5: Choose the topic directory and filename

**Topic directory:** reuse an existing `~/.lattice/docs/{topic}/` when one fits,
otherwise derive a kebab-case name from the query.

**Filename:** derive from the specific focus of the query.

| Query | Topic Dir | Research File |
|-------|-----------|---------------|
| "tesla model s value retention" | `tesla-model-s/` | `value-retention.md` |
| "bun vs node performance" | `bun-nodejs/` | `performance-comparison.md` |
| "graphql authentication patterns" | `graphql/` | `authentication-patterns.md` |

Kebab-case, 2–4 words, descriptive of the focus. Never `notes.md` or
`research.md`.

### Step 6: Write the document

Every research document is an OKF concept, and **frontmatter is required** —
there is no extraction pass that would infer it later. A file with no `type` is
still indexed, but it is filed as a problem and cannot be filtered on.

**`~/.lattice/docs/{topic}/{filename}.md`:**

```markdown
---
type: Research Note
title: Bun versus Node.js performance
description: Where Bun's startup and HTTP throughput differ from Node.js, and why.
tags: [bun, runtime, performance]
generated: { by: claude-code/research, at: 2026-09-20T00:00:00Z }
sources:
  - path: runtime-overview.md
    title: Bun and Node.js runtimes
  - https://bun.sh/docs/benchmarks
---

# Bun versus Node.js performance

## Startup

...

## Throughput

...

## Sources

1. [Bun benchmarks](https://bun.sh/docs/benchmarks)
```

| Field | Rule |
|-------|------|
| `type` | Required. `Research Note` unless a more specific type already exists in the bundle |
| `title` | Required. The document's own name, not the query |
| `description` | Required. One sentence; it is what search shows beside the path |
| `tags` | Required. Kebab-case, reusing tags the bundle already uses |
| `generated` | Required. `{ by: claude-code/research, at: <UTC ISO 8601> }` — what wrote it and when |
| `sources` | Every source drawn on. A bare URL for something outside the bundle; `{ path, title }` for a document inside it, path relative to this file's directory |

An in-bundle `sources:` entry becomes a `cited` edge in the graph; one pointing
at a document that does not exist yet stays unresolved and repairs itself when
that document is written. Headings matter: chunks are cut at them, so a section
per question is what makes a passage findable.

### Step 7: Write or update the topic index

**`~/.lattice/docs/{topic}/index.md`** — `index.md` is reserved by the format,
so it is navigation and never a concept. It needs no frontmatter.

```markdown
# {Topic Title}

Brief description of what this topic covers.

## Documents

| Document | Description |
|----------|-------------|
| [{Research Title}](./{filename}.md) | Brief description |

## Related Research

- [Related Topic](../related-topic/index.md)
```

For an existing topic, add a row rather than rewriting the file.

### Step 8: Sync

```bash
lattice sync
```

This indexes the changed files, chunks them at their headings, resolves the
links and citations, and embeds whatever has no vector yet.

Verify what landed:

```bash
lattice rels {topic}/{filename} --json   # Citations resolved? Anything unresolved?
lattice search "$ARGUMENTS" --json       # Does the new document answer the query?
```

### Step 9: Confirm

Report to the user:

- The document written, with its path
- Its type, tags and cited sources
- The topic index updated
- That `lattice sync` indexed it, and anything it left unresolved

## Important Notes

- **Frontmatter is required** — `type`, `title`, `description`, `tags`, `generated`, `sources`
- **`index.md`, never `README.md`** — only `index.md` and `log.md` are reserved; a `README.md` would be indexed as a concept
- **Never put research content in the index** — the index is navigation
- Kebab-case for every directory and filename
- Cite every source, and prefer `{ path, title }` for in-bundle citations so the edge resolves
- Cross-link related documents in the body; those links are edges too

## File Structure Standard

```
~/.lattice/docs/{topic-name}/
├── index.md               # Reserved: navigation, not a concept
├── {research-1}.md        # One concept
├── {research-2}.md        # Another
└── {research-n}.md        # Expandable as needed
```

## Command Reference

| Command | Purpose |
|---------|---------|
| `lattice search "query" --json` | Search the bundle, machine-readably |
| `lattice search "query" --concepts` | Which document, rather than which passage |
| `lattice sync` | Index changed files and embed the backlog |
| `lattice rels <concept> --json` | Links, backlinks, siblings and unresolved links |
| `lattice status` | What is indexed, and what is still awaiting a vector |
