# Lattice - a note store agents ask first

One SQLite store of notes on the machine, which every agent session reaches
through an MCP server (`lattice mcp`). A session asks what is already known
before it researches (`recall`), and writes back what it learns (`create_note`,
`append`, `edit`). Every write is attributed and can be undone. Lattice does not
research and does not decide how an agent should; it records and answers. A CLI
of the same name exists for people and for tests.

The decision to move from markdown files to a store is ADR 0001 (`docs/adr/`).
A note is its fields plus an ordered list of sections; search is keyword and
meaning at once over the notes' passages.

## Architecture

- **Backend**: SQLite via `bun:sqlite` (embedded, no external dependencies)
- **Keyword search**: SQLite FTS5 over chunks (`chunks_fts`)
- **Vector search**: a cosine scan over `chunk_embeddings`: no index extension
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `local` provider runs a real ONNX model in the process's own memory from weights cached under the Lattice home: no daemon, no API key, and no network after the first download. The `hash` provider is the deterministic alternative the test suite uses: 512 dimensions derived from a hash of the text, needing no model on disk.
- **Server**: `src/mcp/server.ts`, one per agent session over stdio, all opening the one store
- **Runtime**: Bun

## Key Commands

```bash
lattice init     # Create the home, an empty store, and download the embedding model
lattice mcp      # Serve the store's tools to an agent over stdio (what a session starts)
lattice status   # What the store holds, how search is doing, the last backup and off-Mac copy
lattice search   # Hybrid search: keyword and meaning fused, then expanded one hop
lattice rels     # Show a note's links, backlinks and unresolved links
lattice sql      # Read-only SQL queries
lattice history  # The store's changes, or one change in full
lattice revert   # Undo one change, or put a note back as at a version
lattice export   # Write the store out as markdown (a copy, never read back)
lattice backup   # Take a snapshot of the store now (copied to another machine when one is named)
lattice embed    # Embed what has no vector (`--retry-failed` retries permanent failures,
                 # `--reembed` moves the store to a changed model)
lattice import   # Build the store from Lattice 2's markdown files and Lattice 1's library
```

Every command that reads the store says what to run when there is none:
`lattice init` for an empty one, `lattice import` to bring notes in. Flags take
the next word as their value, so they go after the words they go with
(`lattice search "query" --json`).

`lattice rels <note>` takes either a note's name (`research/jev-reranker`) or its
path (`research/jev-reranker.md`), and `--json` prints the same three relations
machine-readably. Sharing a folder is not a relation.

A note's name is its type's folder plus a slug (`typeDirectory` in
`src/markdown/okf.ts`: lowercased, non-alphanumeric runs to `-`), so a note of
type `BigQuery Table` is `bigquery-table/users`.

## Storage

All data is under one home directory, resolved by `resolvePaths` in
`src/utils/paths.ts`: `LATTICE_HOME` when it is set, otherwise `~/.lattice`.

```
~/.lattice/
├── store.db       # The notes: the only copy (plus SQLite's own -wal/-shm sidecars)
├── backups/       # Snapshots of store.db: one a day on the first write (last 30), and those `lattice backup` takes (last 30);
│                  # .remote-copy.json (how the last copy to another machine went) and .remote-copy-<snapshot>.lock (held while one runs)
├── export/        # Where `lattice export` writes by default: a copy of the notes, never read back
├── archive/       # Notes kept outside the store: v1/ (Lattice 1's library), v2/ (Lattice 2's markdown files); nothing reads them but `lattice import`
├── models/        # Cached embedding weights (`LATTICE_MODEL_DIR` moves it)
├── lattice.db     # Lattice 2's file index; only `lattice import` reads it, to copy vectors and check search
└── .embed.lock    # Held while `lattice embed` is running
```

Configuration is environment variables only: there is no config file.
`resolvePaths` still names an `.env` under the home directory, but nothing reads it.

### Database

`store.db` has its own schema version (2) and `meta.kind = 'note store'`
(`src/store/schema.ts`), so a file index is never mistaken for it and a build
refuses a layout it does not know. It is the file index's tables, unchanged,
plus what files had held (a test pins the layout):

- `concepts` is the notes table. `path` is the note's name plus `.md`, an
  address that relative links resolve against and no file. `identifier` is the
  name. Added columns: `sources`, `version`, `archived`, `next_section`,
  `created_at`, `updated_at`. `frontmatter` holds the note's other fields. Its
  `trust` column is a leftover of the file index that the store never sets; a
  note's checked state is per section.
- `sections` is the note's text: ordered, each with an id (`s1`, `s2`, ...) given
  once and never reused, its heading and depth, its text, its own version and its
  `trust` (`unverified`, `machine-confirmed` for checked by an agent,
  `human-reviewed` for checked by James). The sections joined in order are the
  note's body exactly. `chunks.section_id` is the section a passage starts in.
- `changes`, `change_sections` and `change_fields`: every write, with the text or
  value before and after. A section's entry also keeps the version it had and
  who had checked it, and a change that added, removed or moved a section keeps
  the order the sections stood in (`changes.order_before`), so reading an earlier
  version and undoing are exact rather than inferred. `note_names` holds the old
  names a renamed note answers to. `recall_log` records each question for `stats`.
- Derived from the sections, and rebuilt by every write: `chunks`, `chunks_fts`,
  `tags`, `links`, and the vectors (`chunk_embeddings`, `concept_embeddings`, and
  the two embedding failure tables). The four embedding tables are keyed by
  `(target, model, dim)`, which is what lets two vector spaces coexist while a
  re-embed is in flight.

## Embeddings

A write makes the vectors its changed passages need before its transaction opens
(see Writing). `lattice embed` is the other path: a chunk or note with no vector
is simply a row missing from `chunk_embeddings` / `concept_embeddings`, so a
write that landed while the provider was down leaves a backlog that `embed`
finishes, and an interruption never leaves a half-written note. `embed` skips a
passage that was rewritten while it was being embedded, rather than filing the
old text's vector under the new.

A provider failure is recorded per target in `chunk_embed_failures` /
`concept_embed_failures` as retryable or permanent. Retryable failures are
picked up by the next run; permanent ones only under
`lattice embed --retry-failed`. Both tables hang off their target, so
re-chunking a note takes its stale failure rows with it.

### Models and model changes

`src/embed/models.ts` describes every model Lattice can run: its hub
repository, how its token vectors are pooled, the prefixes it was trained to
expect for a passage as against a query, its native and stored dimensions, and
its context ceiling. The default is `nomic-embed-text-v1.5` stored at 512 of
its native 768 dimensions (a truncation only models trained for it, Matryoshka,
are allowed), and the vector is re-normalised afterwards so a dot product is
still a cosine similarity. `bge-small-en-v1.5` and `mxbai-embed-large-v1` are
also registered.

A model name is normalised before it is compared or stored, so `nomic-ai/…`,
`hf.co/…`, a `:latest` tag and a capital letter are all the same model.

A **vector space** is a `(model, dim)` pair, and the space the store is in is
recorded in `meta.embedding_model` / `meta.embedding_dim`, not inferred from the rows.
`embed` and `search` refuse when the configured model is not the one the store
is in, naming both, the number of chunks affected, where the new name came from,
and the one command that proceeds: `lattice embed --reembed`. That command
writes the new space's vectors beside the old ones and only when the new set is
complete does a single transaction move the pointer and delete the old rows, so
an interrupted re-embed still searches correctly on the old vectors and resumes
where it stopped. A server started under another model answers by keyword and
`stats` says why.

Environment:

| Variable | Meaning |
|---|---|
| `LATTICE_HOME` | The Lattice home; default `~/.lattice`. |
| `LATTICE_EMBED_PROVIDER` | `local` (the default: a real model, in-process) or `hash` (deterministic, no model, what the tests use). An unknown name is an error, never a silent fallback. |
| `LATTICE_EMBED_MODEL` | Which registered model to run. An unregistered name is an error listing the registered ones. |
| `LATTICE_EMBED_DIM` | Stored vector width. For `hash` it is simply the width, and the model name carries it (`hash-512`). For `local` it may only go below the model's native width when the model was trained for truncation. |
| `LATTICE_MODEL_DIR` | Where weights are cached; defaults to `models` under the Lattice home. |
| `LATTICE_OFFLINE` / `HF_HUB_OFFLINE` | Never download. A model already cached is used; a missing one is an error naming the directory and the files to place there. |
| `LATTICE_HF_MIRROR` | Where a download comes from, when not the hub (`HF_ENDPOINT` is honoured as a fallback). |
| `LATTICE_EMBED_FAIL` | Fault injection for tests: `retryable:<substring>` or `permanent:<substring>` makes the hash provider fail on any text containing the substring. |
| `LATTICE_BACKUP_REMOTE` | Where to copy each day's snapshot, as `user@host:folder` over ssh. Unset, nothing is copied. A malformed value is reported by `stats` and `status`, and nothing is copied. |
| `LATTICE_SSH` | The ssh program, if it is not `ssh` on the PATH. |
| `LATTICE_E2E_MODEL` | Set to run `src/embed/local.e2e.test.ts`, the one test that downloads and runs the real model. It is skipped otherwise. |

## Search

`lattice search` and the `recall` tool run two legs over one filtered candidate
set (the FTS5 keyword index over chunks, and a cosine scan over
`chunk_embeddings`) and fuse their rankings with reciprocal rank fusion,
because a tier score and a cosine are not comparable quantities. A similarity
below `SIMILARITY_FLOOR` (0.25) is noise and never enters the fusion, which is
why the non-semantic `hash` provider leaves passage ranking exactly as keyword
search left it. `recall` (`src/store/recall.ts`) adds the store's marks to each
passage: the section it starts in and whether that section is checked, whether
the note is old or archived, and how search ran. The `lattice search` command
prints the engine's own hits, which carry no checked mark (a note has none of
its own; ask `recall`, or `read_note`, for the sections' marks).

`concept_embeddings` is a tiebreak in passage search and nothing more: the
nudge is sized against the smallest gap between two distinct fused scores, so
it can close a tie and can never cross one. In `--concepts` mode it is a leg of
its own, because there the question is which note rather than which passage.

The top hits are then expanded one hop over `links` (outbound and inbound).
Folder siblings are not neighbours. Neighbours are deduplicated against the answers,
capped by `--expand` (default 3, `--no-expand` disables), and always scored
below the weakest direct hit.

When no query vector is usable (unknown provider, a provider that threw, or
nothing in the store embedded with that model) the result is keyword-only and
says so: `--json` carries `degraded` and `degradedReason`, and
`--require-embeddings` turns that into a non-zero exit.

### Reranking

An optional stage between fusion and expansion, behind `Reranker` in
`src/rerank/provider.ts` (the same shape of seam as the embedding provider).
With `LATTICE_RERANK_PROVIDER` unset nothing changes and nothing touches the
network. `jev` sends the fused top `--candidates` (default 20, never below
`--limit`) to TypeSafe's Jev in one request with one Noul per candidate
(title plus the shown passages in full, or in `--concepts` mode title,
description and opening passage) and reorders by the returned probability,
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
| `LATTICE_EMBED_STUB` | With `LATTICE_EMBED_PROVIDER=stub`, a JSON array of phrase groups; a text's vector has one dimension per group it mentions. For tests and demonstrations: it is the only way to show a paraphrase matching without a real model. |
| `LATTICE_RERANK_PROVIDER` | Unset (no reranking), `jev` (TypeSafe, needs `TYPESAFE_API_KEY`; `TYPESAFE_BASE_URL` is honoured) or `stub`. Anything else is an error. |
| `LATTICE_RERANK_MODEL` | The Jev model to ask for; default `jev-latest`. |
| `LATTICE_RERANK_STUB` | With `stub`, a JSON object of phrase → probability; a candidate scores the highest phrase its text contains, 0 if none. Malformed is an error. |
| `LATTICE_RERANK_FAIL` | With `stub`, a substring; a query containing it makes the request throw, to exercise the fallback. |

## Links

`links` records the edges an author wrote: markdown links and wikilinks in a
note's text, plus the `sources` entries that name another note (`kind =
'source'`). Links in fenced code blocks and links to external URLs are not
edges. A link whose target is not a note keeps its `target_path` with a NULL
`target_concept_id`: an unresolved link, standing for knowledge not written
yet; `stats` lists the most wanted. Every write re-resolves the links around the
note it touched (`resolveLinksAround` in `src/store/derive.ts`), so creating the
missing note repairs the edge and archiving or renaming one is followed; a link
resolves through a note's name and the old names it answers to.

## The note store

### Writing

`src/store/store.ts` is the one place a note changes (`createNote`,
`changeNote`): it writes the sections, records the change and refreshes the
note's passages, links and tags (`derive.ts`) in the caller's transaction, and a
passage whose text did not change keeps its vector. It has no guards; they are
above it. `src/store/write.ts` is the machinery every write shares (the
snapshot, the `Planner` that builds a change section by section, the commit, the
embedding before the transaction); `write-text.ts` builds the changes to a
note's text (`edit`, `add_section`, `remove_section`, `move_section`, `append`),
`write-note.ts` the changes about a note as a whole (`create_note`,
`set_fields`, `rename_note`, `archive_note`, `confirm`), and `undo.ts` `revert`.
The tools are registered in `src/mcp/server.ts`.

A write is worked out against a snapshot of the note, the vectors it needs (for
the passages it adds, and for the note's own vector when its title, description
or tags change) are computed before any transaction opens, and then one
`BEGIN IMMEDIATE` transaction checks the note is still at the version the
snapshot was taken at and writes the change and those vectors together. If
another session got in between, the write is worked out again against the new
note (what was embedded is kept): a change to a different passage lands, a change
to the same passage meets its guard and is refused with what to do. Guards: a
quoted passage must occur exactly once in the section named or in the whole note
(a quote across a section boundary is refused); replacing a whole section must
name the version read; `remove_section` may name it, and `confirm` must (a
section rewritten since it was read is not the text that was checked);
`set_fields` may name the note version read, and putting a note back as at a
version must name the version it is at now (`current`), so later work is never
wiped unseen. An edit may not take a section's own heading line away, and no
write may leave the note with no sections. An undo (`revert`) is refused when a
later change touched the same section or field, naming that change, and is itself
a change that can be undone. Embedding failure never fails a write: it lands, is
found by keyword, and the answer says so.

The sections joined must split back into the same sections (`structureProblem`,
checked on every write, undo included). To keep that true, a plan closes by giving
every section but the last a final newline and dropping blank lines from the top
of any section that is not first, and a change that would let a heading be glued
onto the text before it, or an open code block swallow the headings after it, is
refused.

New text containing a heading line starts a new section there, and the first
part keeps the id. `append` goes to the named section, else "Key findings" (a
Topic hub's "Research"), else the last. A rename gives a new name from the type
and title; the old name stays in `note_names`, and links resolve through it
(`resolveLinks` in `derive.ts`). `confirm` takes each section with the version
read; `james_said` makes it "checked by James", and an agent cannot pass itself
off as James with `by`.

### Snapshots, the copy off the Mac, and export

`src/store/backup.ts`: the server takes a snapshot (`VACUUM INTO`, one
consistent read) before the first write of each local day into `backups/`
(`store-YYYY-MM-DD.db`, the last 30); `lattice backup` takes one now
(`store-YYYY-MM-DDTHHMMSS.db`, the last 30 of those). The two kinds are pruned
apart, so a run of manual backups never pushes the daily window out, and a
manual one does not stand in for the day's own. Nothing schedules anything, and
nothing installs a LaunchAgent or a cron entry.

The snapshots sit on the same disk as the store, so they guard against a bad day
and not against losing the machine. `src/store/remote.ts` copies them off it:
with `LATTICE_BACKUP_REMOTE=user@host:folder` set, the server starts a copy of
the day's snapshot over ssh in the background after the day's first write, and
`lattice backup` (with the setting, or `--remote user@host:folder`) takes a fresh
snapshot and copies it on demand. The file is streamed to the other side's
stdin with its size and SHA-256, into a hidden name of that attempt's own; the
far side renames it into place only when both match, and removes it on any other
ending (a stream cut short, a dropped connection), so it holds only whole
snapshots that open as SQLite files, and keeps the newest 30 of each kind. Several
sessions' servers share one home, so a copy of a snapshot first creates
`backups/.remote-copy-<snapshot>.lock` exclusively; a server that finds it held
(by a live process, younger than a copy may run) waits instead of sending the
same file again. A copy never costs a write: it is never awaited, a failure
(host down, no ssh, full disk) is written to `backups/.remote-copy.json`, and
`stats` and `lattice status` report the last good copy with its age and the last
error. A later write tries again once 15 minutes have passed since the last
attempt, so a host that is down is asked a few times a day, not once a write. The
server's copy is stopped when the server goes away. `LATTICE_SSH` names another
ssh program (the tests use stand-ins that run the remote command locally, one
for each way a link fails); ssh runs with `BatchMode`, so it fails rather than
asks.

`src/store/export.ts` writes one file per note (archived ones are left out)
under its type's folder, with a first frontmatter line saying it is a copy, and
a `.lattice-export` manifest listing what it wrote. A later export of the same
folder removes the files of notes renamed or archived since; a folder that holds
anything else is refused, and so is the home's `docs` or any folder that holds
it. `lattice import` refuses an export.

### Reading, search and import

`src/store/read.ts` and `recall.ts` answer the reading tools; every tool answers
in compact JSON, and a refusal is an error result `{ refused, next }`. A server
re-checks the store's schema version on every call and reopens the file if it was
replaced. Search is `src/search` unchanged, reached through `recall` with these
filters added: `notes` (within given notes) and `excludeArchived`.

`lattice import` builds a store from two sources and is how notes arrive from the
earlier versions. It builds in a work file beside `store.db`, verifies it
(`src/store/verify.ts`: text joined back equals each file's body, each note's
fields equal its parsed frontmatter, no file's YAML was unreadable, search
matches the file index) and links it into place only when all of that is clean
and no other store has appeared. A store that does not verify is kept as
`store.db.failed`, never as `store.db`, and the command exits 1. An empty store
(`lattice init` makes one) is replaced; one that holds notes is refused. Search
parity is gated on a bundle-only build (adding the library reorders near-ties by
changing keyword statistics); in the full store the best note must still match
for every question. It reads two sources and writes to neither:

- Lattice 2's markdown files (`<home>/docs`, or `--docs`): a note per file, named
  by its path, vectors copied from `lattice.db` wherever the passage or note
  text is identical (so a bundle embeds nothing);
- Lattice 1's library (`<home>/archive/v1`, `docs/` and `lost/`): a note per
  `.md`, `index.md` included, named `v1/` plus its path, type `Lattice 1`, each
  tagged `old` with a stale-after date in the past (which search already demotes
  by half), stubs also tagged `full-text-lost`, and the two generated title
  lists at the top archived. Embedding it takes minutes and several GB of memory,
  which is why it runs here, once, and never inside a session's server.

### The tools and their size

Every session carries the tools' descriptions, so their size is watched. The 17
tools (six reading, eleven writing) and the server's instructions cost **2,849
input tokens** in Claude Code, measured 2026-11-01 as the difference in input
tokens between `claude -p` runs with and without the server, with tool search
off (`ENABLE_TOOL_SEARCH=false`, so every description is loaded): 6,324
characters of tool JSON, 269 of instructions and the `mcp__lattice__` prefix
Claude Code adds to each name (238), 2.4 characters a token. With Claude Code's
default tool search the descriptions are deferred and the server costs about 330
tokens until a tool is used. The server sends its tool list without the `$schema`
and `additionalProperties` the SDK would add, takes few parameter descriptions
(the names carry them), and a test bounds the sum at 7,000 characters. When
adding a tool or a parameter, re-measure the same way and keep the figure under
3,000.

A deviation from the option, for that budget: `reason` and `by` are on the five
writes that add or judge content (`create_note`, `edit`, `append`, `confirm`,
`revert`) and not on the six structural ones (`add_section`, `remove_section`,
`move_section`, `set_fields`, `rename_note`, `archive_note`), which record the
client and the folder alone. `set_fields` has no list-replacing `sources`
(`add_sources` and `remove_sources` cover it), and clears a field with an empty
string rather than null (`null` costs an `anyOf` in every field's schema).

Who made a change: the client from the handshake and the folder from the
process's working directory (Claude Code starts a user-scope server in the
session's folder); when that is the home folder or the root it falls back to
`CLAUDE_PROJECT_DIR`, then to the client's first root (`roots/list`), and
failing all of those the change records only the client and `by`.

Notes change only through `src/store/store.ts`, so every change is in the
history; `lattice sql` opens the store with `query_only`. Three other writers
exist, none of them a note: the import creating the store (through `createNote`,
then copying vectors it already has, which are derived data), the embed phase
writing vectors, and the server's `recall_log` row for each question
(bookkeeping that feeds `stats` and never costs an answer). The write path also
records a passage's embedding failure and gives a note its note-level vector
after a write, the way `embed` does. A fourth, outside the product, is the tests
in `store.test.ts` and `server.test.ts` that open the store directly for what the
tools cannot do: planting a vector or an old name and moving the schema version.
The other exceptions to "never open the database from a test" are the ones that
open a snapshot (`write.test.ts`, `store-writes.test.ts`), which `lattice sql`
cannot reach because it opens the store only, and the pruning test in
`store-writes.test.ts`, which calls `backup.ts` directly on dated snapshots (it
is a pure function of the folder and a date).

## Development Notes

- No external services: SQLite is embedded and the default embedding provider runs in-process
- `bun run check` is `tsc --noEmit && biome check .`; `bun test` is the whole suite
- Path resolution lives in `src/utils/paths.ts`: never build a storage path by hand
- `src/markdown/` reads markdown (frontmatter, headings, passages, links); the import and the store use it, and nothing reads markdown as the source of notes any more
- `bun run eval:scifact` measures search quality on a SciFact subsample, imported into a store with the real model

## Testing Philosophy

### Two seams

The suite drives two seams, because there are two ways in.

**The CLI** is `runCli` in `src/cli/run.ts`. It takes argv and an environment and
returns `{ code, stdout, stderr }`. It never reads `process.argv`,
`process.env` or the real home directory, and it never throws. A test gets an
isolated home by passing `LATTICE_HOME` pointed at a fresh temporary directory,
so there is no shared connection to manage, nothing to truncate between tests,
and no order dependence. `src/cli/run.test.ts` is search, links, embedding and
model changes through it; a test puts markdown in the home's `docs` and builds
the store with `lattice import`, as a person upgrading would.

**The MCP server** is `createLatticeServer` (`src/mcp/server.ts`) driven by an
in-process MCP client over the real protocol, on a home that `lattice import`
built (`src/store/testing.ts` has the helpers and the fixtures: a bundle, a
library in Lattice 1's shape, and `FILE_INDEX`, the binary file index of that
bundle that Lattice 2's `sync` built, since the code that built it is gone and
the import still reads one). `src/mcp/server.test.ts` is the reading tools,
`src/mcp/write.test.ts` the writing tools, their guards and refusals, undo and
the snapshots, `src/mcp/remote.test.ts` the copy off the Mac (a stand-in `ssh`
that runs the remote command in a folder of the test's).
`src/mcp/concurrent.test.ts` starts real `lattice mcp` processes on one home and
has them write at once (two edits to different passages both land; the same quote
or the same section version, one is refused; four sessions appending twenty
findings lose none; two creating one note, one is told it exists; an undo is
refused after another session changed the section), because the guards are
decided inside SQLite's write lock and only separate processes show they hold.
`src/cli/mcp.test.ts` runs `lattice mcp` as a process. `src/store/import.test.ts`
drives the import and the commands that read the store, and
`src/cli/store-writes.test.ts` `history`, `revert`, `export` and `backup`,
through `runCli`. `src/store/store.test.ts` calls the write primitive directly for
what the tools cannot reach; that and the few places a test plants a row are the
exceptions to "never open the database from a test".

### Rules

1. **Test through the CLI or the server, not around them.** Assert on what a
   command prints and the code it exits with, or on a tool's JSON answer.
   Prefer `--json` output to parsing a rendered table. Never open the database
   directly from a test; `lattice sql` is a command, and using it is driving the
   CLI.
2. **Use the highest interface that can show the behavior.** If `lattice search
   --json` can show it, do not reach for `lattice sql`.
3. **Expected values come from an independent source of truth**: a known-good
   literal, a worked example, the spec, never recomputed the way the code
   computes them.
4. **Pure functions may be tested directly** in a `*.test.ts` beside the source
   when the logic genuinely has no visible behavior of its own. That is the
   exception, not the default.

### Example

```typescript
function invoke(argv: string[], home: string = freshHome()) {
  return runCli({ argv, env: { LATTICE_HOME: home, LATTICE_EMBED_PROVIDER: "hash" } });
}

test("import reports what it brought in", async () => {
  const home = freshHome();
  cpSync(FIXTURE_BUNDLE, join(home, "docs"), { recursive: true });

  const result = await invoke(["import", "--no-library"], home);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Bundle: 10 notes");
});
```
