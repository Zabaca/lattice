# Lattice - Knowledge Graph CLI

A CLI tool that indexes a markdown bundle into an embedded SQLite database and retrieves passages from it by keyword and by meaning at once.

## Architecture

- **Backend**: SQLite via `bun:sqlite` (embedded, zero external dependencies)
- **Keyword search**: SQLite FTS5 over chunks (`chunks_fts`)
- **Vector search**: a cosine scan over `chunk_embeddings`, fused with the keyword leg
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `hash` provider is deterministic — 512 dimensions derived from a hash of the text — so the pipeline needs no model on disk and no network.
- **Runtime**: Bun. No framework, no DI container — the CLI is plain functions behind one seam (`src/cli/run.ts`).

## Key Commands

```bash
lattice status   # Show documents needing sync
lattice sync     # Index the bundle, then embed whatever has no vector
lattice embed    # Embed the backlog alone (`--retry-failed` retries permanent failures)
lattice search   # Hybrid search: keyword and meaning fused, then expanded one hop
lattice sql      # Raw SQL queries
lattice rels     # Show a concept's links, backlinks, siblings and unresolved links
```

`lattice rels <concept>` takes either an OKF identifier (`concepts/users`) or a
bundle path (`concepts/users.md`), and `--json` prints the same four relations
machine-readably.

## Storage

All data is stored in `~/.lattice/` — exactly what `lattice init` creates
(`src/cli/commands/init.ts`, paths from `src/utils/paths.ts`):

```
~/.lattice/
├── docs/          # Markdown documentation — the OKF bundle
└── lattice.db     # SQLite index (plus SQLite's own -wal/-shm sidecars)
```

`LATTICE_HOME` moves the whole directory, which is what lets tests drive the
CLI against a temporary home. There is no config file and no sync manifest:
sync state is the content hash stored per concept in the index, and
configuration is environment variables only.

Run `lattice init` to setup the directory structure.

### Database

The index (`lattice.db`, SQLite — see `src/db/schema.ts`) holds
`concepts`, `tags`, `chunks`, `chunks_fts`, `chunk_embeddings`,
`concept_embeddings`, the two embedding failure tables and `links`.

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

Environment:

| Variable | Meaning |
|---|---|
| `LATTICE_EMBED_PROVIDER` | Provider name; `hash` (the default) is the only one so far. An unknown name is an error, never a silent fallback. |
| `LATTICE_EMBED_DIM` | Dimensions for the hash provider (default 512). The model name carries it: `hash-512`. |
| `LATTICE_EMBED_FAIL` | Fault injection for tests: `retryable:<substring>` or `permanent:<substring>` makes the provider fail on any text containing the substring. |

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

The top hits are then expanded one hop over `links` (outbound and inbound) and
over directory siblings. Neighbours are deduplicated against the answers,
capped by `--expand` (default 3, `--no-expand` disables), and always scored
below the weakest direct hit.

When no query vector is usable — unknown provider, a provider that threw, or
nothing in the index embedded with that model — the result is keyword-only and
says so: `--json` carries `degraded` and `degradedReason`, and
`--require-embeddings` turns that into a non-zero exit.

| Variable | Meaning |
|---|---|
| `LATTICE_EMBED_STUB` | With `LATTICE_EMBED_PROVIDER=stub`, a JSON array of phrase groups; a text's vector has one dimension per group it mentions. For tests and demonstrations — it is the only way to show a paraphrase matching without a real model. |

## Links

`links` records the edges an author wrote: markdown links and wikilinks in a
document's body, plus the frontmatter `sources:` citations that point inside the
bundle (`kind = 'source'`). Links in fenced code blocks and links to external
URLs are not edges. A link whose target is not indexed keeps its `target_path`
with a NULL `target_concept_id` — an OKF unresolved link, standing for knowledge
not written yet. Every sync re-resolves the whole table at the end, so writing
the missing document repairs the edge and deleting a target returns its inbound
links to unresolved.

## Development Notes

- No external services and no API keys: SQLite is embedded and embeddings run in-process
- SQL for every query; `lattice sql` is read-only and refuses to write
- Path utilities in `src/utils/paths.ts` — nothing resolves `~/.lattice` for itself
- `bun run check` is `tsc --noEmit && biome check .`; `bun test` runs the suite

## Testing Philosophy

### One seam

Lattice is tested at a single seam: `runCli` in `src/cli/run.ts`. It takes an
argv tail and an environment and returns an exit code with the text that would
have gone to stdout and stderr. It never reads `process.argv`, `process.env` or
the real home directory, and it never throws. Tests live in
`src/cli/run.test.ts` and drive that function with an isolated `LATTICE_HOME`.

Everything is asserted through that public surface — including the database,
which is read with `lattice sql` rather than by opening the file. Querying the
index directly is a side channel: it lets a test pass while the command that is
supposed to expose the behavior is broken.

### When writing tests

1. **Drive `runCli`** — a new command or flag is tested through the CLI, not through the module beneath it
2. **A fresh `LATTICE_HOME` per test** — `mkdtempSync` per test; each one runs `lattice init` itself, so tests never share state and never need truncation
3. **Fixtures are bundles** — `src/fixtures/*` are real OKF bundles copied into the temporary home, so the shape a document must have is checked rather than described
4. **Expected values come from the fixture**, never recomputed the way the code computes them
5. **Pure functions may have their own `*.test.ts`** beside them (`src/utils/frontmatter.test.ts`) when the logic is genuinely standalone — but reach for the seam first

### Example: the seam

```typescript
function invoke(argv: string[], home: string = freshHome()) {
  return runCli({ argv, env: { LATTICE_HOME: home } });
}

test("indexes the bundle", async () => {
  const home = await bundledHome();       // init + copy a fixture bundle

  const result = await invoke(["sync"], home);

  expect(result.code).toBe(0);
  expect(await sql(home, "SELECT path FROM concepts ORDER BY path")).toEqual([
    { path: "concepts/users.md" },
  ]);
});
```
