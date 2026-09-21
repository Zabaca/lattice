---
name: research
description: Research a topic - searches existing docs, asks before new research
---

Research the topic given in `args`: search what is already indexed, and only then
write something new.

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

### Step 1 & 2: Search what is already indexed, and present it

Run the `search` skill on `<topic>`. It searches `lattice search --json`,
follows up on the strongest hits, and reports what's already indexed —
coverage, gaps, staleness, and whether the search was degraded. Use its
output as the basis for Step 3; do not re-run the search separately here.

### Step 3: Ask before researching

Use AskUserQuestion:

- **"Should I perform new research on this topic?"**
  - Yes — research and write a new document
  - Yes — research and extend an existing document
  - No — the existing research is enough

If **No**, stop here.

### Step 4: Research

Focus on the gap identified in step 2 rather than restating what is already
indexed. Keep every URL you use — they become the document's `sources`.

**If `TYPESAFE_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are in the
environment**, start with the judged loop over the index and the web:

```bash
lattice run "<topic>" --json
```

It plans queries, searches the index and Exa, has Jev judge every result and
rewrites when the judge finds gaps. `kept` holds what is worth citing: a
`source: "web"` entry's `ref` is a URL and goes into `sources`; an
`index` entry's `ref` is a bundle path for Step 6. `tried` is the queries it
searched — reuse them as the WebSearch queries below rather than inventing
new ones. On `exit: decide`, read `records[-1].probabilities` and choose; on
`give_up`, the web has to come from WebSearch alone. If `webReason` is set,
Exa did not run (no `EXA_API_KEY`, no credits, a rejected key, a network
failure) and only the index was searched.

If the keys are absent, or `lattice run` exits non-zero (it prints why),
say so once and run `lattice web` directly instead:

```bash
lattice web "<topic>" --json                     # Neural search; read the highlights
lattice web "<topic>" --json --type fast         # A quicker, shallower pass
lattice web "<topic>" --json --since 2026-01-01  # Anything time-sensitive
lattice web "<topic>" --json --domain docs.example.com --text  # One site, with page text
```

Each result carries the page's `url`, `title`, `publishedDate` and
`highlights` — the passages Exa judged to answer the query — so a result can be
cited without fetching the page. The URLs go into `sources`.

Exa answers a described need well and a literal string badly. Send an error
message, a package version or an exact identifier through WebSearch, not
`lattice web` or `lattice run`. **Always also run WebSearch**: Exa lags on new
content and misses the long tail, so a topic with a fresh or obscure answer
needs both.

If `EXA_API_KEY` is absent, or `lattice web` exits non-zero (no credits, a
rejected key, a network failure — it prints why), say so once and continue
with WebSearch alone. Do not retry, and do not let the run end without web
sources because Exa was unavailable.

When working in the Lattice checkout, the keys are in the repo's `secrets.yaml`:

```bash
export EXA_API_KEY=$(sops -d --extract '["EXA_API_KEY"]' secrets.yaml)
export TYPESAFE_API_KEY=$(sops -d --extract '["TYPESAFE_API_KEY"]' secrets.yaml)
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
using the hits from Step 1 — do not run a new search for this.

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
lattice search "<topic>" --json                  # the new document should now be a hit
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

- What the search found before the research, and whether it was degraded
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
