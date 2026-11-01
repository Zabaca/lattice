# Lattice - Knowledge Graph CLI

A CLI that indexes a bundle of OKF markdown documents into SQLite and searches it by keyword and by meaning at once.

## Architecture

- **Backend**: SQLite via `bun:sqlite` (embedded, no external dependencies)
- **Keyword search**: SQLite FTS5 over chunks (`chunks_fts`)
- **Vector search**: a cosine scan over `chunk_embeddings` — no index extension
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `local` provider runs a real ONNX model in the command's own process from weights cached under the Lattice home — no daemon, no API key, and no network after the first download. The `hash` provider is the deterministic alternative the test suite uses: 512 dimensions derived from a hash of the text, needing no model on disk.
- **Runtime**: Bun

## Key Commands

```bash
lattice init     # Create the home directory and index, and download the embedding model
lattice status   # Show documents needing sync
lattice sync     # Index the bundle, then embed whatever has no vector
lattice embed    # Embed the backlog alone (`--retry-failed` retries permanent failures,
                 # `--reembed` rebuilds the index after a model change)
lattice search   # Hybrid search: keyword and meaning fused, then expanded one hop
lattice sql      # Raw SQL queries
lattice rels     # Show a concept's links, backlinks and unresolved links
lattice import   # Build the note store (store.db) from the bundle and Lattice 1's library
lattice mcp      # Serve the note store's tools to an agent over stdio
```

`search`, `sql`, `rels` and `status` read the file index by default and the note
store with `--store` (the store is not the default until the cutover; see
[The note store](#the-note-store)). `--store` never takes a value, so it may sit
before the query; every other flag takes the next word and goes after it.

`lattice rels <concept>` takes either an OKF identifier (`bigquery-table/users`)
or a bundle path (`bigquery-table/users.md`), and `--json` prints the same three
relations machine-readably. Sharing a directory is not a relation.

A document lives in the directory named by its `type` (`typeDirectory` in
`src/sync/okf.ts`: lowercased, non-alphanumeric runs to `-`), so `type: BigQuery
Table` files under `bigquery-table/`. `status` and `sync` report a document
filed anywhere else as a frontmatter problem, alongside a missing `type`.

## Storage

All data is stored under one home directory, resolved by `resolvePaths` in
`src/utils/paths.ts`: `LATTICE_HOME` when it is set, otherwise `~/.lattice`.

```
~/.lattice/
├── docs/          # The markdown bundle
├── lattice.db     # The SQLite index (plus SQLite's own -wal/-shm sidecars)
├── store.db       # The note store `lattice import` builds (see below)
├── archive/       # Notes kept outside the bundle, such as v1/ (Lattice 1's library)
├── models/        # Cached embedding weights (`LATTICE_MODEL_DIR` moves it)
└── .sync.lock     # Held while a sync is running
```

`lattice init` creates the home directory, `docs/` and `lattice.db`, and fills
`models/` with the weights the `local` provider needs; the lock file appears
only while a sync holds it.

Configuration is environment variables only — there is no config file and no
sync manifest. `resolvePaths` still names an `.env` under the home directory,
but nothing reads it. Sync state is the content hash stored per concept in the
index.

### Database

The index (`lattice.db`, SQLite — see `src/db/schema.ts`) holds
`concepts`, `tags`, `chunks`, `chunks_fts`, `chunk_embeddings`,
`concept_embeddings`, the two embedding failure tables and `links`. The four embedding tables are
keyed by `(target, model, dim)`, which is what lets two vector spaces coexist
while a re-embed is in flight.

## Embeddings

The embed phase runs at the end of `lattice sync` and is the whole of
`lattice embed`; there is one code path either way. A chunk or concept with no
vector is simply a row missing from `chunk_embeddings` / `concept_embeddings`,
so an interruption leaves a backlog rather than a half-written document.

A provider failure is recorded per target in `chunk_embed_failures` /
`concept_embed_failures` as retryable or permanent. Retryable failures are
picked up by the next run; permanent ones only under
`lattice embed --retry-failed`. Both tables hang off their target, so
re-chunking a document takes its stale failure rows with it.

### Models and model changes

`src/embed/registry.ts` describes every model Lattice can run: its hub
repository, how its token vectors are pooled, the prefixes it was trained to
expect for a passage as against a query, its native and stored dimensions, and
its context ceiling. The default is `nomic-embed-text-v1.5` stored at 512 of
its native 768 dimensions — a truncation only models trained for it (Matryoshka)
are allowed, and the vector is re-normalised afterwards so a dot product is
still a cosine similarity. `bge-small-en-v1.5` and `mxbai-embed-large-v1` are
also registered.

A model name is normalised before it is compared or stored, so `nomic-ai/…`,
`hf.co/…`, a `:latest` tag and a capital letter are all the same model.

A **vector space** is a `(model, dim)` pair, and the space the index is in is
recorded in `meta.embedding_model` / `meta.embedding_dim` — not inferred from the rows.
`sync`, `embed` and `search` refuse when the configured model is not the one
the index is in, naming both, the number of chunks affected, where the new name
came from, and the one command that proceeds: `lattice embed --reembed`. That
command writes the new space's vectors beside the old ones and only when the
new set is complete does a single transaction move the pointer and delete the
old rows — so an interrupted re-embed still searches correctly on the old
vectors and resumes where it stopped.

Environment:

| Variable | Meaning |
|---|---|
| `LATTICE_EMBED_PROVIDER` | `local` (the default: a real model, in-process) or `hash` (deterministic, no model, what the tests use). An unknown name is an error, never a silent fallback. |
| `LATTICE_EMBED_MODEL` | Which registered model to run. An unregistered name is an error listing the registered ones. |
| `LATTICE_EMBED_DIM` | Stored vector width. For `hash` it is simply the width, and the model name carries it (`hash-512`). For `local` it may only go below the model's native width when the model was trained for truncation. |
| `LATTICE_MODEL_DIR` | Where weights are cached; defaults to `models` under the Lattice home. |
| `LATTICE_OFFLINE` / `HF_HUB_OFFLINE` | Never download. A model already cached is used; a missing one is an error naming the directory and the files to place there. |
| `LATTICE_HF_MIRROR` | Where a download comes from, when not the hub (`HF_ENDPOINT` is honoured as a fallback). |
| `LATTICE_EMBED_FAIL` | Fault injection for tests: `retryable:<substring>` or `permanent:<substring>` makes the hash provider fail on any text containing the substring. |
| `LATTICE_E2E_MODEL` | Set to run `src/embed/local.e2e.test.ts`, the one test that downloads and runs the real model. It is skipped otherwise. |

## Search

`lattice search` runs two legs over one filtered candidate set — the FTS5
keyword index over chunks, and a cosine scan over `chunk_embeddings` — and
fuses their rankings with reciprocal rank fusion, because a tier score and a
cosine are not comparable quantities. A similarity below `SIMILARITY_FLOOR`
(0.25) is noise and never enters the fusion, which is why the non-semantic
`hash` provider leaves passage ranking exactly as keyword search left it.

`concept_embeddings` is a tiebreak in passage search and nothing more: the
nudge is sized against the smallest gap between two distinct fused scores, so
it can close a tie and can never cross one. In `--concepts` mode it is a leg of
its own, because there the question is which document rather than which passage.

The top hits are then expanded one hop over `links` (outbound and inbound).
Directory siblings are not neighbours. Neighbours are deduplicated against the answers,
capped by `--expand` (default 3, `--no-expand` disables), and always scored
below the weakest direct hit.

When no query vector is usable — unknown provider, a provider that threw, or
nothing in the index embedded with that model — the result is keyword-only and
says so: `--json` carries `degraded` and `degradedReason`, and
`--require-embeddings` turns that into a non-zero exit.

### Reranking

An optional stage between fusion and expansion, behind `Reranker` in
`src/rerank/provider.ts` (the same shape of seam as the embedding provider).
With `LATTICE_RERANK_PROVIDER` unset nothing changes and nothing touches the
network. `jev` sends the fused top `--candidates` (default 20, never below
`--limit`) to TypeSafe's Jev in one request with one Noul per candidate —
title plus the shown passages in full, or in `--concepts` mode title,
description and opening passage — and reorders by the returned probability,
fused score as tiebreak. A reranked hit's `score` is that probability and
`fusedScore` keeps the pre-rerank score; expansion then hangs off the reranked
answers, so its floor is the lowest probability (possibly 0). The result
carries `reranked`, `rerank: { provider, model, candidates, inputTokens } |
null` and `rerankReason` when a configured reranker fell back. A configuration
error (unknown name, `jev` without `TYPESAFE_API_KEY` or with one the service
rejects, malformed stub) is a hard error; a request failure degrades to the
fused order and says so, and
`--require-rerank` turns that into a non-zero exit. Semantic degradation and
rerank degradation are independent: a keyword-only search is still reranked.

| Variable | Meaning |
|---|---|
| `LATTICE_EMBED_STUB` | With `LATTICE_EMBED_PROVIDER=stub`, a JSON array of phrase groups; a text's vector has one dimension per group it mentions. For tests and demonstrations — it is the only way to show a paraphrase matching without a real model. |
| `LATTICE_RERANK_PROVIDER` | Unset (no reranking), `jev` (TypeSafe, needs `TYPESAFE_API_KEY`; `TYPESAFE_BASE_URL` is honoured) or `stub`. Anything else is an error. |
| `LATTICE_RERANK_MODEL` | The Jev model to ask for; default `jev-latest`. |
| `LATTICE_RERANK_STUB` | With `stub`, a JSON object of phrase → probability; a candidate scores the highest phrase its text contains, 0 if none. Malformed is an error. |
| `LATTICE_RERANK_FAIL` | With `stub`, a substring; a query containing it makes the request throw, to exercise the fallback. |

## Links

`links` records the edges an author wrote: markdown links and wikilinks in a
document's body, plus the frontmatter `sources:` citations that point inside the
bundle (`kind = 'source'`). Links in fenced code blocks and links to external
URLs are not edges. A link whose target is not indexed keeps its `target_path`
with a NULL `target_concept_id` — an OKF unresolved link, standing for knowledge
not written yet. Every sync re-resolves the whole table at the end, so writing
the missing document repairs the edge and deleting a target returns its inbound
links to unresolved.

## The note store

Lattice is moving from files to a store (ADR 0001, `docs/adr/`). Slice 2 of 5
is built: the store, the import and the reading tools. The files stay the
source until the cutover (slice 4), so everything above still describes the
default behaviour.

`store.db` (path `store` in `resolvePaths`) is a separate SQLite file with its
own schema version (1) and `meta.kind = 'note store'`, so an index is never
mistaken for it (`src/store/schema.ts`). It is the index's tables, unchanged,
plus what files had held (a test pins the layout):

- `concepts` is the notes table. `path` is the note's name plus `.md`, an
  address that relative links resolve against and no file. `identifier` is the
  name. Added columns: `sources`, `version`, `archived`, `next_section`,
  `created_at`, `updated_at`. `frontmatter` holds the note's other fields.
- `sections` is the note's text: ordered, each with an id (`s1`, `s2`, ...) given
  once and never reused, its heading and depth, its text, its own version and its
  `trust` (`unverified`, `machine-confirmed` for checked by an agent,
  `human-reviewed` for checked by James). The sections joined in order are the
  note's body exactly. `chunks.section_id` is the section a passage starts in.
- `changes`, `change_sections` and `change_fields`: every write, with the text or
  value before and after. `note_names` holds the old names a renamed note answers
  to. `recall_log` records each question for `stats`.

`src/store/store.ts` is the one place a note changes (`createNote`,
`changeNote`): it writes the sections, records the change and refreshes the
note's passages, links and tags (`derive.ts`) in the caller's transaction, and a
passage whose text did not change keeps its vector. It has no guards yet; those,
and the tools that build changes from an agent's words, are slice 3.

`src/store/read.ts` and `recall.ts` answer the reading tools; `src/mcp/server.ts`
registers them (`recall`, `read_note`, `list_notes`, `links`, `stats`,
`history`). Every tool answers in compact JSON; a refusal is an error result
`{ refused, next }`. A server re-checks the store's schema version on every call
and reopens the file if it was replaced. Search is `src/search` unchanged,
reached through `recall` with these filters added: `notes` (within given notes)
and `excludeArchived`.

`lattice import` builds the store in a work file beside `store.db`, verifies it
(`src/store/verify.ts`: text joined back equals each file's body, each note's
fields equal its parsed frontmatter, no file's YAML was unreadable, search
matches the file index) and links it into place only when all of that is clean
and no other store has appeared. A store that does not verify is kept as
`store.db.failed`, never as `store.db`, and the command exits 1. Search parity is
gated on a bundle-only build (adding the library reorders near-ties by changing
keyword statistics); in the full store the best note must still match for every
question. It reads two sources and writes to neither:

- the bundle (`<home>/docs`): a note per file, named by its path, vectors copied
  from `lattice.db` wherever the passage or note text is identical;
- Lattice 1's library (`<home>/archive/v1`, `docs/` and `lost/`): a note per
  `.md`, `index.md` included, named `v1/` plus its path, type `Lattice 1`, each
  tagged `old` with a stale-after date in the past (which search already demotes
  by half), stubs also tagged `full-text-lost`, and the two generated title lists
  at the top archived. Embedding it takes minutes and several GB of memory, which
  is why it runs here, once, and never inside a session's server.

Every session carries the tools' descriptions, so their size is watched: the six
reading tools are 3,933 characters of JSON (about 1,000 tokens by characters over
four; about 1,500 as Claude Code counts them, measured 2026-11-01 as the extra
input tokens of loading them). The aim for all 17 is under 3,000, which the
write tools in slice 3 will have to fit by trimming schemas and descriptions.

Notes change only through `src/store/store.ts`, so every change is in the
history; `lattice sql` opens the store with `query_only`. Three other writers
exist, none of them a note: the import creating the store (through `createNote`,
then copying vectors it already has, which are derived data), the embed phase
writing vectors, and the server's `recall_log` row for each question
(bookkeeping that feeds `stats` and never costs an answer). A fourth, outside
the product, is the tests in `store.test.ts` and `server.test.ts` that open the
store directly for what the write primitive cannot do yet: marking a section
checked, planting a vector or an old name, and moving the schema version.

## Development Notes

- No external services: SQLite is embedded and the default embedding provider runs in-process
- `bun run check` is `tsc --noEmit && biome check .`; `bun test` is the whole suite
- Path resolution lives in `src/utils/paths.ts` — never build a storage path by hand

## Testing Philosophy

### One seam

The suite drives a single seam: `runCli` in `src/cli/run.ts`. It takes argv and
an environment and returns `{ code, stdout, stderr }`. It never reads
`process.argv`, `process.env` or the real home directory, and it never throws.
Tests live in `src/cli/run.test.ts` and go through it — argv in, exit code and
output out.

A test gets an isolated home by passing `LATTICE_HOME` pointed at a fresh
temporary directory, so there is no shared connection to manage, nothing to
truncate between tests, and no order dependence.

### The store's seams

The note store has a second seam, because the tools are what agents use:
`createLatticeServer` (`src/mcp/server.ts`) driven by an in-process MCP client
over the real protocol, in `src/mcp/server.test.ts`, on a home that `lattice
import` built (`src/store/testing.ts` has the helpers and the fixtures: a bundle
in today's shape and a library in Lattice 1's). `src/cli/mcp.test.ts` runs
`lattice mcp` itself as a process. `src/store/import.test.ts` drives the import
and the `--store` commands through `runCli`. The write tools do not exist yet, so
`src/store/store.test.ts` and the few server tests that need a note with a
history call the store's write primitive directly; that is the exception to
"never open the database from a test".

### Rules

1. **Test through the CLI, not around it.** Assert on what a command prints and
   the code it exits with. Prefer `--json` output to parsing a rendered table.
   Never open the database directly from a test; `lattice sql` is a command, and
   using it is driving the CLI.
2. **Use the highest interface that can show the behavior.** If `lattice search
   --json` can show it, do not reach for `lattice sql`.
3. **Expected values come from an independent source of truth** — a known-good
   literal, a worked example, the spec — never recomputed the way the code
   computes them.
4. **Pure functions may be tested directly** in a `*.test.ts` beside the source
   when the logic genuinely has no CLI-visible behavior of its own. That is the
   exception, not the default.

### Example

```typescript
function invoke(argv: string[], home: string = freshHome()) {
  return runCli({ argv, env: { LATTICE_HOME: home } });
}

test("sync reports what it indexed", async () => {
  const home = freshHome();
  await invoke(["init"], home);
  cpSync(FIXTURE_BUNDLE, join(home, "docs"), { recursive: true });

  const result = await invoke(["sync"], home);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Indexed");
});
```
