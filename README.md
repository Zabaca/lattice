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
lattice search "query" --candidates 30   # Reranker reads deeper (default 20)
lattice search "query" --require-rerank  # Fail if a configured reranker fell back
```

With no usable embedding — no provider, or an index embedded by another model
— the search still answers from keywords alone. `--json` then reports
`"degraded": true` with a reason, so a caller can say the answer is weaker than
usual; `--require-embeddings` turns that into a non-zero exit instead.

A reranker is optional and off by default. `LATTICE_RERANK_PROVIDER=jev` sends
the fused top `--candidates` hits (at least `--limit`) to TypeSafe's Jev in one
request, needs `TYPESAFE_API_KEY`, and takes the model from
`LATTICE_RERANK_MODEL` (default `jev-latest`). Each hit's `score` becomes the
probability it answers the query, the pre-rerank score stays beside it as
`fusedScore`, and `--json` reports `reranked` and `rerank` (provider, model,
candidates, input tokens). Neighbours are still expanded afterwards, below the
reranked answers. A misconfigured reranker — an unknown name, `jev` with no key or a rejected one
— is an error, but a request that fails leaves the fused order and says so:
`rerankReason` in JSON, `Not reranked: …` in the terminal; `--require-rerank`
makes that a non-zero exit. `LATTICE_RERANK_PROVIDER=stub` with
`LATTICE_RERANK_STUB` (a JSON object of phrase → probability) and
`LATTICE_RERANK_FAIL` (a substring that makes the request fail) exist for tests.

### `lattice web`

Search the web through [Exa](https://exa.ai) and print the results with the
passages Exa picked out as answering the query, so the `/research` skill can
cite a page without fetching it. It needs `EXA_API_KEY`, and it is the only
command that touches the network beyond the embedding-model download and an
optional reranker.

```bash
lattice web "what exa search is not good for"          # Numbered results, highlights indented
lattice web "query" --json                              # { query, type, results, cost, searchTime, requestId }
lattice web "query" --type fast                         # instant, fast, auto (default), deep-lite, deep, deep-reasoning
lattice web "query" --since 2026-01-01                  # Published on or after a date
lattice web "query" --domain exa.ai --domain github.com # Only these hosts
lattice web "query" --text                              # Page text beside the highlights (up to 4000 characters)
lattice web "query" --limit 20                          # Results, 1 to 100 (default 10)
```

There is no fallback inside the command: a missing or rejected key, an empty
balance, a rate limit or an unreachable host is a non-zero exit with the
reason, and the `/research` skill falls back to its ordinary web search.
`EXA_BASE_URL` points the request elsewhere. `LATTICE_WEB_PROVIDER=stub` with
`LATTICE_WEB_STUB` (a JSON array of `{ title, url, highlights }`) and
`LATTICE_WEB_FAIL` (a substring that makes the request fail) exist for tests.

### `lattice run`

Run the search as a judged loop: a model plans two queries, the index and the
web (Exa, plus whatever `LATTICE_WEB_ESCALATE` names once a round has fallen
short) are searched, TypeSafe's Jev judges every candidate and the set as a whole,
and code decides whether to answer, rewrite the queries (up to `--max-rewrites`,
default 2), give up, or hand the decision back. The point is fewer agent turns
for the `/search` and `/research` skills: one command returns the sources worth
citing instead of a page of hits to read. `/jev-search` and `/research-jev` are
the skills built on it.

```bash
lattice run "how do agentic search loops decide when to stop"           # exit line, kept sources, cost
lattice run "question" --json                                            # { question, exit, tried, completeness, kept, records, cost, webReason }
lattice run "question" --no-web                                          # The index alone
lattice run "question" --no-index                                        # The web alone, judged
lattice run "question" --max-rewrites 0                                  # Plan, search, judge, stop
lattice run "question" --tried "first query" --tried "second query"      # Skip the plan; search these
```

A web page the judge drops on its excerpt while saying the page itself
probably holds the answer is read in full (Exa's contents endpoint, about a
tenth of a cent), chunked at its headings, and judged again on the passages
that best match the question; such a page is marked `read` in `kept`.
`exit` is `answer` (cite `kept`), `give_up` (nothing citable), or `decide`
(the judge was unsure; `records[-1].probabilities` says how). The policy in
code corrects the judge's known habits: an `answer` over a set it rated below
"most of the answer" is sent round again, and running out of rewrites, or
rewriting into the same queries, ends over what was kept rather than as a
failure. It needs `TYPESAFE_API_KEY` for the judge and `CLAUDE_CODE_OAUTH_TOKEN`
(or `ANTHROPIC_API_KEY`) for the model — inside a Claude Code session, where
the harness hides that variable from commands, export the token as
`LATTICE_OAUTH_TOKEN` instead; `EXA_API_KEY` is optional, and a web
leg that cannot run is reported as `webReason` while the run goes on over the
index. `LATTICE_LLM_PROVIDER=stub` with `LATTICE_LLM_STUB` (a JSON array of
completions) and `LATTICE_JUDGE_PROVIDER=stub` with `LATTICE_JUDGE_STUB` (a
JSON array of verdicts) exist for tests.

### `lattice research`

The research skill as one command. The judged loop runs over the index; from
what the judge kept the command decides `answered` (a complete answer is
already indexed; nothing is written), `extend` (a research document it kept
has most of the answer) or `new`. Unless answered, the loop runs again over
the web on the same queries, a model (Sonnet by default) writes or extends the
document from the kept passages, the command checks it — type, title,
description, at least one wikilink, `sources` cut to what the run actually
read — files it under `research/`, cites the topic hub and links back from the
hub's `## Research` section, syncs, and reads the document's links back. The
hub is the one the index run kept, else the one Jev places the topic under
from the ten hubs the index ranks highest, else a new one the command writes
from the subject the writer names. `/research-jev` is the
skill built on it: run, then present.

```bash
lattice research "reciprocal rank fusion tie handling"          # the findings, then what was written where, hub, rels, cost
lattice research "what Exa's deep search type costs" --json     # { topic, decision, index, web, document, reason, cost, webReason }
lattice research "topic" --max-rewrites 0                        # One round per loop
```

Exit 0 is the loop finishing, whatever it decided; `reason` says why nothing
was written when nothing was. A document the writer gets wrong twice is exit
1 with the `draft` in the JSON and nothing on disk. It needs what `lattice
run` needs, and `LATTICE_WRITE_PROVIDER=stub` with `LATTICE_WRITE_STUB` (a
JSON array of documents) exists for tests.

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
| `EXA_API_KEY` | The key `lattice web` sends to Exa; the command refuses without it | unset |
| `EXA_BASE_URL` | Where `lattice web` sends its request | `https://api.exa.ai` |
| `LATTICE_WEB_PROVIDER` | A comma-separated list of web legs: `exa`, `claude` (Claude's own WebSearch tool, through the Agent SDK) and `stub` for tests (with `LATTICE_WEB_STUB` and `LATTICE_WEB_FAIL`); several are searched together | `exa` |
| `LATTICE_WEB_ESCALATE` | Legs added from the first rewrite on, once Exa has failed to satisfy the judge; `claude` is the one worth naming | none |
| `TYPESAFE_API_KEY` | The key the `jev` reranker and the `lattice run` judge send to TypeSafe | unset |
| `CLAUDE_CODE_OAUTH_TOKEN` | Forwarded to the Claude Agent SDK by `lattice run`; `ANTHROPIC_API_KEY` is the alternative | unset |
| `LATTICE_OAUTH_TOKEN` | The same token under a name a Claude Code session's Bash tool can see; skills need this one | unset |
| `LATTICE_LLM_PROVIDER` | `claude`, or `stub` for tests (with `LATTICE_LLM_STUB`) | `claude` |
| `LATTICE_LLM_MODEL` | The model `lattice run` plans and rewrites with | `claude-haiku-4-5` |
| `LATTICE_WRITE_PROVIDER` | `claude`, or `stub` for tests (with `LATTICE_WRITE_STUB`); the writer `lattice research` calls once | `claude` |
| `LATTICE_WRITE_MODEL` | The model `lattice research` writes the document with | `claude-sonnet-5` |
| `LATTICE_CLAUDE_PATH` | A Claude Code executable for the SDK to run, when not the bundled one | unset |
| `LATTICE_JUDGE_PROVIDER` | `jev`, or `stub` for tests (with `LATTICE_JUDGE_STUB`) | `jev` |

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

`bun run eval:scifact` measures search quality (hit@k, MRR@10) on a subsample of
the SciFact benchmark, indexed with the real embedding model. The first run
downloads about 5 MB into `eval-cache/` and embeds for a few minutes; later runs
reuse the synced home and only re-run the queries. `--docs`, `--queries`,
`--seed`, `--fresh` and `--json` are the knobs. `--rerank jev` runs every search
with the Jev reranking stage on (`--candidates`, default 20) and needs
`TYPESAFE_API_KEY` (or the SOPS-encrypted `secrets.yaml`).

</details>

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.
