# @zabaca/lattice

**A local-first retrieval engine for your markdown knowledge base**

[![npm version](https://img.shields.io/npm/v/@zabaca/lattice.svg)](https://www.npmjs.com/package/@zabaca/lattice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Lattice indexes a directory of markdown — an [OKF](https://github.com/Zabaca/lattice)
bundle — into a SQLite database, and answers questions against it by keyword and
by meaning at once. Everything runs on your machine: no server, no container, no
API key.

## The Workflow

```bash
/research "knowledge graphs"   # Find existing docs, write new research, sync
lattice search "your query"    # Search your knowledge base
```

---

## Why Lattice?

| | Lattice | Typical GraphRAG tools |
|---|---|---|
| **Database** | Embedded SQLite (one file) | Docker containers required |
| **External services** | None | 2–3 (DB + vector + graph) |
| **API keys needed** | None | 2–3 (LLM + embedding + rerank) |
| **Embeddings** | In-process, behind a provider seam | A paid embedding API |
| **Unit of retrieval** | The passage that answers you | The whole document |
| **Graph** | The links you actually wrote | LLM-guessed entities |

---

## Quick Start

### What You Need

- **Bun** (or Node.js ≥ 18) — nothing else. No Docker, no API key.

### 1. Install

```bash
bun add -g @zabaca/lattice
lattice init
```

`lattice init` creates `~/.lattice/` with a `docs/` directory for your markdown
and `lattice.db` for the index. It is safe to run again.

### 2. Write and index

```bash
# Put markdown in ~/.lattice/docs/, then:
lattice sync                  # Index it, and embed whatever has no vector
lattice search "your query"   # Search it
```

### 3. Research with Claude Code (optional)

Copy `commands/research.md` from this package into `.claude/commands/` (or
`~/.claude/commands/` for every project), then:

```bash
claude
/research "your topic"        # Search what exists, then write what does not
```

The `/research` command searches your bundle with `lattice search --json`,
asks whether new research is wanted, writes a conforming OKF document with
frontmatter and cited sources, and syncs it.

---

## Documents

A document is a markdown file under `~/.lattice/docs/`. Its frontmatter is what
makes it filterable and citable:

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
...
```

Frontmatter is read permissively: a file missing it is still indexed, just
without a type to filter on. `index.md` and `log.md` are reserved names in every
directory — they are navigation and a changelog, never concepts.

---

## CLI Reference

### `lattice init`

Create `~/.lattice/`, its `docs/` directory, and the SQLite index. Idempotent.

```bash
lattice init
```

### `lattice sync`

Index the bundle, then embed whatever has no vector.

```bash
lattice sync
```

Every file is hashed and compared with what the index holds, so a second sync
with no change does no work. A chunk with no vector is simply a missing row, so
an interrupted run leaves a backlog rather than a half-written document.

### `lattice status`

Show what is indexed, the embedding model in use, and how much is still awaiting
a vector.

```bash
lattice status
```

### `lattice embed`

Embed the backlog on its own — the same code path `sync` ends with.

```bash
lattice embed                  # Everything with no vector, plus retryable failures
lattice embed --retry-failed   # Also retry failures recorded as permanent
```

### `lattice search`

Hybrid search: one query runs keyword matching and semantic matching over the
same filtered candidate set, and the two rankings are fused, so an exact
identifier and a paraphrase that shares no words with the document both find
their answer without choosing a mode. The top hits are then expanded one hop
over the links the author wrote — in both directions — plus directory
siblings, and those neighbours are always ranked below the direct hits.

```bash
lattice search "query"                   # Passages, with neighbours below them
lattice search "query" --json            # The same, machine-readable
lattice search "query" --concepts        # Which document, rather than which passage
lattice search "query" --expand 5        # More neighbours (default 3)
lattice search "query" --no-expand       # Direct hits only
lattice search "query" --require-embeddings  # Fail instead of degrading
lattice search "query" --type Guide --dir concepts --tag core
```

With no usable embedding — no provider, or an index embedded by another model
— the search still answers from keywords alone. `--json` then reports
`"degraded": true` with a reason, so a caller can say the answer is weaker than
usual; `--require-embeddings` turns that into a non-zero exit instead.

### `lattice rels`

Show what a document is connected to: the documents it links to, the documents
linking back at it, the documents filed beside it, and the links it makes that
nothing answers yet.

```bash
lattice rels concepts/users        # By OKF identifier
lattice rels concepts/users.md     # Or by bundle path
lattice rels concepts/users --json # The same four relations, machine-readable
```

The edges come from the links the author wrote. Links inside fenced code blocks
and links to external URLs are not edges; a frontmatter `sources:` citation that
points inside the bundle is one, reported as `cited`. A link to a document that
has not been written is kept and listed under **Unresolved** — write that
document, sync, and the edge resolves itself.

### `lattice sql`

Run a read-only SQL query against the index.

```bash
lattice sql "SELECT path, type, title FROM concepts ORDER BY path LIMIT 10"
lattice sql "SELECT tag, count(*) FROM tags GROUP BY tag"
```

---

## Configuration

### Storage

Everything lives under one directory, `~/.lattice/` by default:

```
~/.lattice/
├── docs/          # Your markdown — the OKF bundle
└── lattice.db     # SQLite index: concepts, chunks, links, embeddings
```

That is everything `lattice init` creates. Configuration is environment
variables only — there is no config file.

`lattice.db` is one file, beside SQLite's own `-wal` and `-shm` sidecars — copy
all three, or none of them and re-sync. Deleting the lot and running
`lattice sync` rebuilds the index from `docs/`, which is the source of truth.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LATTICE_HOME` | The Lattice home directory | `~/.lattice` |
| `LATTICE_EMBED_PROVIDER` | Embedding provider. An unknown name is an error, never a silent fallback | `hash` |
| `LATTICE_EMBED_DIM` | Dimensions for the `hash` provider | `512` |

Embeddings run in-process behind a provider seam. The default `hash` provider is
deterministic — a vector derived from a hash of the text — so the pipeline needs
no model on disk and no network. It is not semantic: with it, passage ranking is
exactly what keyword search produced.

<details>
<summary><b>How It Works (Technical Details)</b></summary>

### Chunking

A document is split at its headings, and each chunk keeps its heading path and
its line range in the original file — so a result points at the passage that
answers you, and at the lines to open.

### Retrieval

Two legs run over one filtered candidate set: the FTS5 keyword index over
chunks, and a cosine scan over the chunk embeddings. Their rankings are fused
with reciprocal rank fusion, because a tier score and a cosine are not
comparable quantities. A similarity below the floor is treated as noise and
never enters the fusion.

The top hits are then expanded one hop over the `links` table — outbound and
inbound — and over directory siblings. Neighbours are deduplicated against the
answers and always scored below the weakest direct hit.

### Links

`links` records the edges an author wrote: markdown links and wikilinks in a
document's body, plus the frontmatter `sources:` citations that point inside the
bundle. A link whose target is not indexed keeps its path with no target — an
unresolved link, standing for knowledge not written yet. Every sync re-resolves
the whole table, so writing the missing document repairs the edge.

</details>

---

## Contributing

<details>
<summary><b>Development Setup</b></summary>

### Prerequisites

- Bun (Node.js ≥ 18 to run the built CLI)

### Setup

```bash
git clone https://github.com/Zabaca/lattice.git
cd lattice
bun install
```

### Running Locally

```bash
bun run lattice search "query"      # Run the CLI from source
bun test                            # Run the test suite
bun run check                       # Typecheck and lint
bun run build                       # Build to dist/
```

</details>

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built with [Bun](https://bun.sh/), SQLite, and [Claude Code](https://claude.ai/code)
