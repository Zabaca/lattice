# @zabaca/lattice

**A local note store that every agent session asks first**

[![npm version](https://img.shields.io/npm/v/@zabaca/lattice.svg)](https://www.npmjs.com/package/@zabaca/lattice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Lattice keeps what your agents have researched in one SQLite database on your
machine and hands it to every Claude Code session through an
[MCP](https://modelcontextprotocol.io) server. Before a session researches, it
asks Lattice what is already known; when it learns something, it writes it
back. Every change is attributed, kept in a history, and can be undone. Search
is keyword and meaning at once. Nothing leaves your machine, and there is no API
key to obtain.

Lattice does not research. It answers what is known and records what an agent
tells it; how to find out more (the web, your data, source code) is the calling
agent's choice.

---

## What you need

- **Bun** (the CLI and the server run on Bun).
- Nothing else. The store is a SQLite file, and embeddings are produced
  in-process: no database server, no container, no embedding API key.

---

## Quick start

```bash
bun add -g @zabaca/lattice
lattice init                    # creates ~/.lattice and downloads the embedding model (about 145 MB, once)
claude mcp add --scope user lattice -- lattice mcp
```

That registers the server for every project. Each session starts its own
`lattice mcp`, and all of them share `~/.lattice/store.db`. To make sessions
actually use it, tell them to in your agent instructions (for Claude Code,
`~/.claude/CLAUDE.md`), for example:

```
Before researching or answering from memory, ask Lattice (its recall tool). When you learn something durable, write it back (create_note, append, edit).
```

### From a checkout

Run the server from the source instead of an installed package with absolute
paths (an MCP client cannot start a shell function):

```bash
claude mcp add --scope user lattice -- /path/to/bun run --no-env-file \
  --config=/path/to/lattice/bunfig.toml /path/to/lattice/src/main.ts mcp
```

`--no-env-file` and `--config` keep a project's own `.env` and `bunfig.toml` out
of the server, which Claude Code starts in whichever project the session is in.

### Coming from Lattice 2 (markdown files)

Lattice 2 kept notes as markdown files in `~/.lattice/docs` with a file index.
`lattice import` reads those files (and, if there, Lattice 1's library in
`~/.lattice/archive/v1`), builds the store, and installs it only when every
note's text and fields came through exactly and search answers as the index did:

```bash
lattice import          # prints the report; exit 1 and "SOMETHING DIFFERS" means nothing was installed
```

It writes nothing to the files. When you are satisfied, move `~/.lattice/docs`
to `~/.lattice/archive/v2`; nothing reads it but `lattice import`. Lattice 2
stays on npm as `@zabaca/lattice@2`.

---

## The tools

Every tool answers in short JSON; lists give names plus one line; a refusal says
what to do next.

| Tool | What it does |
|---|---|
| `recall` | Ask what is known. Hybrid search; each passage comes with its note, its section, whether it is checked, whether it is old or stale, and whether search ran in full. |
| `read_note` | A note's outline (section ids, sizes, checked) and its text; long notes give the outline and the first section, then sections by id. Can read an earlier version. |
| `list_notes` | Browse by type or tag, paged. |
| `links` | A note's links out, links in, and links to notes not written yet. |
| `stats` | Counts, search health, recent changes, the notes most wanted, the last backup and the last off-machine copy. |
| `history` | The changes to a note or to the whole store, newest first; one change in full. |
| `create_note` | A new note, named from its type and title. Refused if the name is taken. |
| `edit` | Replace a quoted passage (it must occur exactly once) or a whole section, several at once, all or none. |
| `add_section`, `remove_section`, `move_section` | Reorganize a note by section id. |
| `append` | Add a finding to a section (default "Key findings"), with its source. |
| `set_fields` | Title, description, status, stale-after date, tags and sources. |
| `rename_note`, `archive_note` | A new name (the old one keeps working); hide a note without losing it. |
| `confirm` | Mark sections checked, by the caller or (on James's word) by the person. A later write unchecks the section it touched. |
| `revert` | Undo one change, or put a note back as at a version. Refused, naming the change, when a later one touched the same section. |

A note is its fields plus an ordered list of sections, each with a short id that
never changes. A section's text runs from its heading line to the next heading,
so the sections joined in order are the note's markdown. What an agent writes
counts at once and is marked unchecked until someone confirms it. Two sessions
changing different passages of one note both land; two changing the same
passage, the second is refused ("read the section again").

---

## The documents

A note has a type, a title, a description, tags, sources, a status and an
optional stale-after date, plus any other fields it was written with. Its name
is its type's folder and a slug: a note of type `Research` titled `Tesla Model S
value retention` is `research/tesla-model-s-value-retention`. Links between
notes are ordinary markdown links and wikilinks in the text; a link to a note
that does not exist yet is kept, and `stats` lists the most wanted.

`lattice export [dir]` writes the store out as markdown, one file per note, to
read or keep. The export is marked as a copy and nothing reads it back.

---

## CLI reference

The CLI is for people and tests; agents use the tools.

<details>
<summary><b>Commands</b></summary>

```bash
lattice init                   # Create the home, an empty store, and download the embedding model
lattice mcp                    # Serve the tools over stdio (what a session starts)
lattice status                 # What the store holds, search health, last backup and off-machine copy
lattice search "query"         # Hybrid search over passages
lattice rels research/some-note  # A note's links, backlinks and unresolved links
lattice sql "SELECT ..."       # Read-only SQL against the store
lattice history [note]         # The changes, or --change <id> for one in full
lattice revert <change>        # Undo one change (or: revert <note> --version n --current m)
lattice export [dir]           # Write the store out as markdown (a copy, never read back)
lattice backup [--remote host:dir]  # Snapshot the store now; copies it to another machine when one is named
lattice embed                  # Embed what has no vector (--retry-failed, --reembed)
lattice import                 # Build the store from Lattice 2's files and Lattice 1's library
```

### `lattice search`

The same engine as the `recall` tool. One query runs keyword matching and
semantic matching over the same filtered candidate set and the rankings are
fused, so an exact identifier and a paraphrase that shares no words with the
note both find their answer. The top hits are then expanded one hop over the
links the authors wrote, in both directions, always ranked below the direct hits.

```bash
lattice search "query"                   # Passages, with neighbours below them
lattice search "query" --json            # The same result, machine-readable
lattice search "query" --concepts        # Which note, rather than which passage
lattice search "query" --expand 5        # More neighbours (default 3)
lattice search "query" --no-expand       # Direct hits only
lattice search "query" --require-embeddings  # Fail instead of degrading
lattice search "query" --type Research --tag core
lattice search "query" --candidates 30   # Reranker reads deeper (default 20)
lattice search "query" --require-rerank  # Fail if a configured reranker fell back
```

With no usable embedding the search still answers from keywords alone and says
so (`"degraded": true` with a reason in `--json`; `recall` and `stats` say it
too). A reranker is optional and off by default: `LATTICE_RERANK_PROVIDER=jev`
sends the fused top hits to TypeSafe's Jev, needs `TYPESAFE_API_KEY`, and takes
the model from `LATTICE_RERANK_MODEL` (default `jev-latest`).

### `lattice sql`

Runs a query against the store and prints the rows as JSON. SQLite's own
`query_only` mode enforces the read-only part: notes change only through the
tools, so that every change is in the history.

```bash
lattice sql "SELECT identifier, title FROM concepts LIMIT 10"
lattice sql "SELECT type, count(*) AS n FROM concepts GROUP BY type"
```

### `lattice backup`

Takes a snapshot of the store into `~/.lattice/backups` (the server also takes
one before the first write of each day; the last 30 of each kind are kept). When
`LATTICE_BACKUP_REMOTE` is set, or `--remote user@host:folder` is given, it
copies the snapshot to another machine as well; see below.

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
| `LATTICE_BACKUP_REMOTE` | Where to copy the daily snapshot, as `user@host:folder` (over ssh) | unset |
| `LATTICE_SSH` | The ssh program, if not `ssh` | `ssh` |
| `TYPESAFE_API_KEY` | The key the `jev` reranker sends to TypeSafe | unset |

Changing the model is safe: vectors from two models are not comparable, so a
store embedded with one refuses to search or embed under another (it answers by
keyword, and says so), naming both models and the number of passages affected,
and `lattice embed --reembed` rebuilds the vectors, keeping the old ones until
the new ones are complete, so an interrupted rebuild still searches correctly
and simply resumes.

### Storage and backups

```
~/.lattice/
├── store.db         # The notes: the only copy
├── backups/         # Snapshots of store.db
├── export/          # Where `lattice export` writes by default
├── archive/         # Earlier versions' notes (v1, v2); only `lattice import` reads them
└── models/          # Cached embedding weights
```

`store.db` is the only copy of the notes. The server takes a snapshot before the
first write of each day and keeps the last 30, which guards against a bad day or
a damaged file. The snapshots sit on the same disk, so to survive losing the
machine, name another one:

```bash
claude mcp add --scope user lattice -e LATTICE_BACKUP_REMOTE=me@other-box:lattice-backups -- lattice mcp
```

The first write of each day then starts a copy of that day's snapshot over ssh in
the background (key-based login; ssh never prompts). A copy that fails, because
the machine is off or ssh is not set up, never affects a write: `stats` and
`lattice status` show the last good copy and the last error, and a later write
tries again after 15 minutes. The other machine keeps the newest 30 and holds
only whole snapshots, each a SQLite file you can open as it is.
`lattice backup` copies a fresh snapshot on demand. Nothing is
scheduled: no LaunchAgent, no cron.

<details>
<summary><b>How it works</b></summary>

### Writes and history

Every write is one change, recorded in the transaction that makes it: the note,
the version it made, when, who (the client and the project folder the session
runs in, plus an optional name), the kind, an optional reason, and the text or
value before and after of every section and field it touched. There is no write
without a change. Reading an earlier version and undoing a change come from
that record.

### Indexing

The search index (passages, keyword index, vectors, links) is derived from the
sections and refreshed by every write; a passage whose text did not change keeps
its vector, so a one-passage edit embeds one or two passages. If embedding fails,
the write still lands, its passages are found by keyword, and `recall` and
`stats` say so.

### Embeddings

Embeddings are produced in-process behind the `EmbeddingProvider` seam
(`src/embed/provider.ts`). The default `local` provider runs a real ONNX model in
the process's own memory from weights cached under the Lattice home: no daemon,
no API key, and no network once the model is there. The model loads only when a
session first asks or writes, and then takes about 400 MB. `hash` is the
deterministic alternative with no model on disk; it is not a semantic model, so
with it ranking is what keyword search alone would give.

A vector space is a `(model, dim)` pair, and the one the store is in is recorded
rather than inferred, so two models can never be mixed.

### Ranking

The keyword leg and the semantic leg run over one filtered candidate set and
are fused with reciprocal rank fusion, because a BM25 tier and a cosine are not
comparable quantities. A similarity below the floor never enters the fusion.
Notes marked old (imported from Lattice 1) and notes past their stale-after date
have their score halved, so newer research outranks them.

</details>

---

## Contributing

<details>
<summary><b>Development</b></summary>

```bash
git clone https://github.com/Zabaca/lattice.git
cd lattice
bun install

bun test              # The suite: the CLI seam and the MCP server seam
bun run check         # tsc --noEmit && biome check
bun run lattice -- status   # Run the CLI from source
bun run build
```

`bun run eval:scifact` measures search quality (hit@k, MRR@10) on a subsample of
the SciFact benchmark, imported into a store with the real embedding model. The
first run downloads about 5 MB into `eval-cache/` and embeds for a few minutes;
later runs reuse the home and only re-run the queries. `--docs`, `--queries`,
`--seed`, `--fresh` and `--json` are the knobs. `--rerank jev` runs every search
with the Jev reranking stage on (`--candidates`, default 20) and needs
`TYPESAFE_API_KEY` (or the SOPS-encrypted `secrets.yaml`).

`CLAUDE.md` describes the code; `docs/adr/0001-notes-live-in-a-store.md` records
why the notes moved from files to a store.

</details>

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.
