# @zabaca/lattice

**A local-first retrieval engine for a markdown knowledge base**

[![npm version](https://img.shields.io/npm/v/@zabaca/lattice.svg)](https://www.npmjs.com/package/@zabaca/lattice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Lattice indexes a bundle of [OKF](#the-documents)-shaped markdown documents into
a SQLite file and answers questions against it: keyword and meaning at once,
expanded one hop over the links you wrote. Nothing leaves your machine, and
there is no API key to obtain.

## The Workflow

```bash
/research "knowledge graphs"   # Search what you already have, then write what you don't
lattice search "your query"    # Hybrid search over passages
```

---

## What you need

- **Bun** (the CLI runs on Bun).
- Nothing else. The index is a SQLite file, and embeddings are produced
  in-process — no database server, no container, no embedding API key.

---

## Quick Start

No API key. Embeddings are computed on your machine by a model `lattice init`
downloads once (about 145 MB); after that, indexing and search work offline.

### 1. Install

```bash
bun add -g @zabaca/lattice
lattice init
```

`lattice init` creates `~/.lattice/` with a `docs/` bundle directory and an
empty `lattice.db`, and downloads the embedding model into `~/.lattice/models/`
with progress as it goes. It is safe to run again: nothing already in place is
fetched twice.

The `/research` and `/search` skills for Claude Code ship as a plugin in this
repository. Add it as a marketplace and install it:

```
/plugin marketplace add zabaca/lattice
/plugin install lattice@lattice
```

### 2. Put markdown in the bundle and index it

```bash
cp -r my-notes ~/.lattice/docs/
lattice sync
```

### 3. Search

```bash
lattice search "how does chunking work"
```

---

## The documents

A Lattice document is an OKF concept: markdown with frontmatter.

```markdown
---
type: Research
title: Tesla Model S value retention
description: How well the Model S holds its resale value.
status: draft
tags: [tesla, resale]
generated: { by: agent:claude-code/research, at: 2026-09-20T00:00:00Z }
sources:
  - ../bigquery-table/users.md
  - https://example.com/depreciation
---

# Tesla Model S value retention

Depreciation flattens after the fourth year.
```

`type` is what makes a file conforming. A file without it is still indexed —
`lattice status` reports it as a frontmatter problem rather than dropping it.

A document lives in the directory named by its type — lowercased, with runs
of anything but letters and digits turned into a hyphen, so `type: Research`
files under `research/` and `type: BigQuery Table` under `bigquery-table/`.
`lattice status` and `lattice sync` report a document filed anywhere else.

`index.md` and `log.md` are reserved in every directory: they are navigation and
changelog, not knowledge, and are never indexed as concepts.

A document is chunked at its headings, so search points at the passage that
answers the question rather than at the file that contains it.

---

## Using /research

`/research "your topic"` searches the index first with `lattice search --json`,
shows you which documents and which passages already cover the topic, and asks
before doing new research. What it writes is a conforming concept — type, title,
description, tags, `generated` provenance and its `sources` — filed under the
directory its type names (`research/`, or `topic/` for a hub that links out to
the research on a subject), linked into the graph, and synced. There is no
`index.md` to maintain: `lattice rels` computes what one would list.

---

## CLI Reference

<details>
<summary><b>Commands</b></summary>

### `lattice init`

Create `~/.lattice/`, its `docs/` bundle directory, and the SQLite index.

```bash
lattice init
```

### `lattice sync`

Index the bundle — everything new, changed, renamed or deleted since the last
run — then embed whatever still has no vector. Interrupting it leaves a backlog,
not a half-written document.

```bash
lattice sync
```

### `lattice status`

What is indexed, what is still awaiting a vector, and which files have
frontmatter problems.

```bash
lattice status
```

### `lattice embed`

Embed the backlog on its own — the same code path `lattice sync` ends with.

```bash
lattice embed                   # Everything with no vector
lattice embed --retry-failed    # Also retry the permanent failures
```

### `lattice search`

Hybrid search: one query runs keyword matching and semantic matching over the
same filtered candidate set, and the two rankings are fused, so an exact
identifier and a paraphrase that shares no words with the document both find
their answer without choosing a mode. The top hits are then expanded one hop
over the links the author wrote — in both directions — and those neighbours
are always ranked below the direct hits. Sharing a directory is not a link.

```bash
lattice search "query"                   # Passages, with neighbours below them
lattice search "query" --json            # The same result, machine-readable
lattice search "query" --concepts        # Which document, rather than which passage
lattice search "query" --expand 5        # More neighbours (default 3)
lattice search "query" --no-expand       # Direct hits only
lattice search "query" --require-embeddings  # Fail instead of degrading
lattice search "query" --type Guide --tag core
```

With no usable embedding — no provider, or an index embedded by another model
— the search still answers from keywords alone. `--json` then reports
`"degraded": true` with a reason, so a caller can say the answer is weaker than
usual; `--require-embeddings` turns that into a non-zero exit instead.

### `lattice rels`

Show what a document is connected to: the documents it links to, the documents
linking back at it, and the links it makes that nothing answers yet.

```bash
lattice rels bigquery-table/users        # By OKF identifier
lattice rels bigquery-table/users.md     # Or by bundle path
lattice rels bigquery-table/users --json # The same three relations, machine-readable
```

The edges come from the links the author wrote. Links inside fenced code blocks
and links to external URLs are not edges; a frontmatter `sources:` citation that
points inside the bundle is one, reported as `cited`. A link to a document that
has not been written is kept and listed under **Unresolved** — write that
document, sync, and the edge resolves itself.

### `lattice sql`

Run a read-only SQL query against the index and print the rows as JSON. SQLite's
own `query_only` mode enforces the read-only part, so a statement that would
write is refused rather than pattern-matched against.

```bash
lattice sql "SELECT path, type, title FROM concepts LIMIT 10"
lattice sql "SELECT type, count(*) AS n FROM concepts GROUP BY type"
```

</details>

---

## Configuration

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LATTICE_HOME` | The Lattice home directory | `~/.lattice` |
| `LATTICE_EMBED_PROVIDER` | `local` (a real model, in-process) or `hash` (deterministic, for tests). An unknown name is an error, never a silent fallback. | `local` |
| `LATTICE_EMBED_MODEL` | Which registered model to use | `nomic-embed-text-v1.5` |
| `LATTICE_EMBED_DIM` | Stored vector width; only a model trained for truncation may go below its native width | `512` |
| `LATTICE_MODEL_DIR` | Where model weights are cached | `$LATTICE_HOME/models` |
| `LATTICE_OFFLINE` / `HF_HUB_OFFLINE` | Never download; use what is already cached | unset |
| `LATTICE_HF_MIRROR` | Download the weights from somewhere other than the hub (`HF_ENDPOINT` also works) | unset |

Changing the model is safe: vectors from two models are not comparable, so a
`sync` under a changed model refuses, naming both models and the number of
chunks affected, and `lattice embed --reembed` rebuilds the index — keeping the
old vectors until the new ones are complete, so an interrupted rebuild still
searches correctly and simply resumes.

### Storage

```
~/.lattice/
├── docs/            # The markdown bundle
├── lattice.db       # The SQLite index
├── .env             # Local configuration
└── .sync.lock       # Held while a sync is running
```

`lattice.db` holds the concepts, their chunks, the FTS index over those chunks,
the embeddings, and the links. Back it up or delete it freely: it is derived
entirely from the markdown, and `lattice sync` rebuilds it.

<details>
<summary><b>How it works</b></summary>

### Indexing

`lattice sync` walks the bundle, reads each file's OKF frontmatter, and chunks
the body at its headings. The chunks go into an FTS5 index; the links and the
in-bundle `sources:` citations go into a `links` table, which is re-resolved in
full at the end of every sync — so writing a document that was only linked to
repairs the edge, and deleting one returns its inbound links to unresolved.

### Embeddings

Embeddings are produced in-process behind the `EmbeddingProvider` seam
(`src/embed/provider.ts`). The default `local` provider runs a real ONNX model
in the command's own process from weights cached under the Lattice home: no
daemon, no API key, and no network once the model is there. `hash` is the
deterministic alternative — no model on disk, no network — which makes the
pipeline runnable anywhere; it is not a semantic model, so with it ranking is
what keyword search alone would give.

A chunk with no vector is a row missing from `chunk_embeddings` for the active
vector space, so an interruption leaves a backlog rather than corruption. A
provider failure is recorded per target as retryable or permanent; retryable
failures are picked up by the next run, permanent ones only under
`lattice embed --retry-failed`.

A vector space is a `(model, dim)` pair, and the one the index is in is
recorded rather than inferred, so two models can never be mixed. See
**Environment variables** above for what a model change does.

### Ranking

The keyword leg and the semantic leg run over one filtered candidate set and
are fused with reciprocal rank fusion, because a BM25 tier and a cosine are not
comparable quantities. A similarity below the floor never enters the fusion.

</details>

---

## Contributing

<details>
<summary><b>Development</b></summary>

```bash
git clone https://github.com/Zabaca/lattice.git
cd lattice
bun install

bun test              # The suite, driven through the CLI seam
bun run check         # tsc --noEmit && biome check
bun run lattice -- status   # Run the CLI from source
bun run build
```

</details>

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.
