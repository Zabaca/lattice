---
name: research-jev
description: Research a topic with the judged loop (lattice run) - searches existing docs, asks before new research
---

Research the topic given in `args`: run the judged search loop over the
index, present what is already indexed, and only then research the web and
write something new.

It differs from the `research` skill in one way: `lattice run` plans the
queries, searches, and has Jev judge every hit, so the index search and its
coverage report are one command, the web search after the ask is one more,
and the document's citations come from their output.


## Where documents live

All documents live in the Lattice bundle, `~/.lattice/docs/` (or `$LATTICE_HOME/docs`
when that is set). Never write research into a project-local `docs/` directory.

A document lives in the directory named by its OKF `type`, lowercased and
kebab-cased, flat within that directory. There is no subject directory and no
`index.md`: the subject is carried by the filename and, when it recurs, by a
`Topic` document.

| Path | Purpose |
|------|---------|
| `~/.lattice/docs/` | The bundle root |
| `~/.lattice/docs/{type}/{filename}.md` | One concept, filed under its type |
| `~/.lattice/docs/research/` | `type: Research` — findings on a specific question |
| `~/.lattice/docs/topic/` | `type: Topic` — a hub that describes a subject and links out to its research |


## Process

### Step 1: Run over the index

Run this once, exactly as written, and do not check the environment first:

```bash
lattice run "<topic>" --no-web --json
```

It plans queries, searches the index, has Jev judge every result and
rewrites when the judge finds gaps. The web is not searched here: the
question at this point is whether the corpus already has the answer. Read
from the JSON:

- `exit` — `answer`, `decide` or `give_up`.
- `completeness` (0 to 3) and `completenessLabel` — the judge's rating of
  the kept set as a whole.
- `kept[]` — `{ source, title, ref, text }`. `ref` is the bundle path and
  `text` the full matching passages.
- `tried[]` — every query the runner searched.
- `records[]` — one per judge visit, with `probabilities` over `answer`,
  `rewrite` and `give_up`.

Do not run `lattice search`, the `search` skill, or read the files behind
the index hits: the passages in `kept` are the coverage report.

If it exits non-zero it prints why (no `TYPESAFE_API_KEY`, no
`LATTICE_OAUTH_TOKEN` — Claude Code hides `CLAUDE_CODE_OAUTH_TOKEN` from
commands, so the token has to be exported under that name — or no index).
Say so in one line and fall back to the `research` skill: `lattice search
"<topic>" --json` for this step, and `lattice web "<topic>" --json` in
Step 4.

### Step 2: Present what is indexed

From `kept`, tell the user, with paths:

- Which documents cover the topic, quoting the passage from `text` that does.
- Staleness and trust, read from the path and the passage: a `research/`
  document is findings on one question, a `topic/` document is a hub.
- The completeness label, in the judge's words, and what the kept set does
  *not* cover.
- The queries in `tried`, in one line.

### Step 3: Ask, driven by the exit

Use AskUserQuestion:

- **"Should I perform new research on this topic?"**
  - Yes — research and write a new document
  - Yes — research and extend an existing document
  - No — the existing research is enough

Put the option the run points to first, marked "(Recommended)":

| Run | Recommend |
|-----|-----------|
| `answer` with completeness "A complete answer" | No |
| "Most of the answer" or a partial label, with documents kept | Extend an existing document — name the kept document |
| `give_up`, or nothing kept | New document |

On `decide`, show `records[-1].probabilities` in the question text and
recommend by the label as above.

If **No**, stop here.

### Step 4: Research the gap

The gap is what the completeness label says is missing, not a guess. Focus
on it rather than restating what is already indexed. Keep every URL you use
— they become the document's `sources`.

Run the loop again, this time over the web alone:

```bash
lattice run "<topic>" --no-index --json
```

The index was searched in Step 1 and is not searched again. The run sends
each query through two web legs, Exa and Claude's own WebSearch tool, and
the judge reads both legs' pages, so `completenessLabel` is about what the
web adds. The entries in `kept` are the web sources: their `ref` is a URL
and `text` the highlights the leg picked out, or, for an entry with `read:
true`, the passages of the page that best answer the question, chosen after
the runner read the page in full. Cite the URLs and quote from the text
without fetching the pages.

The run does the WebSearch step itself, so do not repeat it. Run WebSearch
yourself, reusing the run's `tried` as the queries, only when:

- the run exits `give_up`;
- the topic is a literal string (an error message, a package version, an
  exact identifier), which Exa answers badly;
- `webReason` names the `claude` leg, so the run searched Exa alone.

If `webReason` is set, a leg did not run and the field says which and why
(no `EXA_API_KEY`, no credits, a rejected key, a network failure, no Claude
credential). Say so once and go on with what the other leg kept. Do not
retry, and if neither leg ran, do not let the run end without web sources:
run WebSearch yourself.

When working in the Lattice checkout, the keys are in the repo's
`secrets.yaml`, and the OAuth token in `~/.claude/settings.json`:

```bash
export EXA_API_KEY=$(sops -d --extract '["EXA_API_KEY"]' secrets.yaml)
export TYPESAFE_API_KEY=$(sops -d --extract '["TYPESAFE_API_KEY"]' secrets.yaml)
export LATTICE_OAUTH_TOKEN=...   # never CLAUDE_CODE_OAUTH_TOKEN: the harness hides that name
```

### Step 5: Choose the type and filename

**Type** — `Research` for findings that answer a specific question. `Topic`
for a hub: a document that describes a subject and links out to the research
on it. A run that answers a question writes `Research`; it writes a `Topic`
only under the rule in Step 6.

**Filename** — kebab-case, naming the subject *and* the specific focus, since
the directory no longer carries the subject. Never `notes.md`, `research.md`
or a name that only makes sense next to a directory name.

| Query | Document |
|-------|----------|
| "tesla model s value retention" | `research/tesla-model-s-value-retention.md` |
| "bun vs node performance" | `research/bun-nodejs-performance-comparison.md` |
| "graphql authentication patterns" | `research/graphql-authentication-patterns.md` |

### Step 6: Connect it to the graph

A document with no in-bundle edges is a leaf nobody can reach except by
search. Sharing a directory with another document is not an edge — only a
link or a citation is. Before writing, decide what the new document links to,
using the index entries in `kept` — they are the `sources:` citations and
the wikilink targets; do not run a new search for this.

**Cite what it builds on.** For each indexed document the new research
extends, contradicts, or relies on, add it to `sources:` as a bundle-relative
path. That is the `cited` edge. Cite because the content depends on it, not
because it came up in the search.

**Cite the Topic hub.** If a `topic/{subject}.md` exists for the subject,
cite it in `sources:` — that is how a piece of research declares which
subject it belongs to. If none exists and the subject will recur, write one in
the same run: `type: Topic`, a description of the subject, and wikilinks out
to the research on it (including the document being written). The hub is a
real concept, not an index, and it is what replaces a subject directory.

**Link what it mentions.** Where the body refers to something an indexed
document already covers, write a wikilink instead of a bare name. A wikilink
target is an OKF identifier, resolved from the writing document's directory:
`[[tesla-model-3-value-retention]]` for another document in `research/`,
`[[/topic/tesla-model-s]]` or `[[../topic/tesla-model-s]]` for a document of
another type. Links inside fenced code blocks are not edges.

**Name what is missing.** When the research leans on a concept nobody has
written yet — a technology, a method, an organisation it keeps returning to —
link it anyway, as `[[/{type}/{name}]]`, and leave it unresolved. An
unresolved link is the graph's record that the knowledge is wanted; do not
stub an empty file to satisfy it. If the concept is worth more than a name
and you have the material, write it as its own concept in the same run: one
document per concept, the same frontmatter rules as Step 7.

Do not put entities in frontmatter. The concept is the document; the link is
the edge.

### Step 7: Write the document

Every document is an OKF concept, and its frontmatter is not optional: `type` is
what makes the file conforming, and a file without it is indexed but reported by
`lattice status` as a frontmatter problem.

`~/.lattice/docs/research/{filename}.md`:

```markdown
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
```

Field by field:

| Field | Rule |
|-------|------|
| `type` | Required. `Research` for findings, `Topic` for a hub. It decides the directory: a `Research` document in any directory but `research/` is reported by `lattice status`. |
| `title` | Required. Human-readable, the document's own name, carrying the subject. |
| `description` | Required. One sentence on what the document answers — it is indexed, so it is how the document is found. |
| `status` | `draft`, `stable` or `deprecated`. New research is `draft`. |
| `tags` | A list. Subject and facet, lowercase kebab-case. |
| `generated` | Provenance: `by` (`agent:claude-code/research`) and `at` (the UTC instant, ISO 8601). |
| `sources` | What the research drew on, as decided in Step 6. A bundle-relative path becomes a `cited` edge in the graph; a URL is kept as a citation and is not an edge. |

Cite the same URLs again as markdown links in a `## Sources` section, so a
reader of the rendered document can follow them. In the body, the wikilinks
from Step 6 stand where the bare names would have been.

### Step 8: Link from the Topic hub

If `topic/{subject}.md` exists, add a wikilink to the new document there —
under a heading such as `## Research` — so the new document has a backlink and
the hub stays the place a reader starts from. If Step 6 wrote a new hub, it
already links out; nothing more to do.

There is no `index.md` to maintain. `index.md` is OKF's reserved navigation
name and is never indexed; the hub is a concept and is.

### Step 9: Sync

```bash
lattice sync
```

This indexes the document, chunks it at its headings, extracts the links and
`sources:` citations, and embeds whatever has no vector yet.

Then verify, through the CLI rather than by assumption:

```bash
lattice status                                   # frontmatter problems, if any
lattice rels research/{filename}.md              # links, backlinks, unresolved
```

If `lattice status` reports a frontmatter problem for the new file, fix the
frontmatter and sync again. If it reports the file as filed outside its type's
directory, move the file — do not change its type to match the directory — and
sync again; the sync follows the rename.

Read the `lattice rels` output against what Step 6 intended. Every link and
citation you meant to resolve should appear under **Outgoing**, the hub (when
there is one) under **Incoming**, and only the concepts you deliberately left
unwritten under **Unresolved**. A link you expected to resolve but did not is
almost always a wrong path — fix the link, not the target, and sync again.

### Step 10: Confirm

Tell the user:

- What the Step 1 run found: the kept documents and the completeness label;
  and which web legs ran in Step 4 (`webReason`)
- The document path, and the Topic hub it hangs off (written or updated)
- What `lattice rels` reports the document is connected to, including anything
  still unresolved

## Notes

- One document per concept, filed under its type. The subject is in the
  filename and the `Topic` hub, never in a directory.
- kebab-case for every directory and filename.
- Every document has `type`, `title`, `description`, `tags`, `generated` and
  `sources`.
- Every document cites or links at least what it builds on; the graph is the
  links the author wrote, and a document nobody links to or from is a leaf.
- An unresolved link is not a failure: it names a document that has not been
  written yet, and writing it repairs the edge on the next sync.
- There is no entity extraction. A thing worth a node is a document; a
  reference to it is a wikilink.

## File structure

```
~/.lattice/docs/
├── research/
│   ├── tesla-model-s-value-retention.md   # type: Research
│   └── tesla-model-3-value-retention.md
└── topic/
    └── tesla-model-s.md                   # type: Topic — links out to both
```
