# Lattice - Knowledge Graph CLI

A CLI that indexes a bundle of OKF markdown documents into SQLite and searches it by keyword and by meaning at once.

## Architecture

- **Backend**: SQLite via `bun:sqlite` (embedded, no external dependencies)
- **Keyword search**: SQLite FTS5 over chunks (`chunks_fts`)
- **Vector search**: a cosine scan over `chunk_embeddings` — no index extension
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `local` provider runs a real ONNX model through transformers.js on the user's own machine — downloaded once by `lattice init`, cached under `<LATTICE_HOME>/models`, offline thereafter. The deterministic `hash` provider stays selectable and is what the test suite drives.
- **Runtime**: Bun

## Key Commands

```bash
lattice init     # Create the home directory, the docs bundle and the index
lattice status   # Show documents needing sync
lattice sync     # Index the bundle, then embed whatever has no vector
lattice embed    # Embed the backlog alone (`--retry-failed` retries permanent failures, `--reembed` rebuilds under a changed model)
lattice search   # Hybrid search: keyword and meaning fused, then expanded one hop
lattice sql      # Raw SQL queries
lattice rels     # Show a concept's links, backlinks, siblings and unresolved links
```

`lattice rels <concept>` takes either an OKF identifier (`concepts/users`) or a
bundle path (`concepts/users.md`), and `--json` prints the same four relations
machine-readably.

## Storage

All data is stored under one home directory, resolved by `resolvePaths` in
`src/utils/paths.ts`: `LATTICE_HOME` when it is set, otherwise `~/.lattice`.

```
~/.lattice/
├── docs/          # The markdown bundle
├── lattice.db     # The SQLite index
├── models/        # Downloaded embedding models — offline after the first run
├── .env           # Local configuration
└── .sync.lock     # Held while a sync is running
```

`lattice init` creates the home directory, `docs/`, `models/` and `lattice.db`,
and downloads the default embedding model; the lock file appears only while a
sync holds it.

### Database

The index (`lattice.db`, SQLite — see `src/db/schema.ts`) holds
`concepts`, `tags`, `chunks`, `chunks_fts`, `chunk_embeddings`,
`concept_embeddings`, the two embedding failure tables and `links`.

## Embeddings

The embed phase runs at the end of `lattice sync` and is the whole of
`lattice embed`; there is one code path either way. A chunk or concept with no
vector is simply a row missing from `chunk_embeddings` / `concept_embeddings`,
so an interruption leaves a backlog rather than a half-written document.

### The model registry and model-change safety

`src/embed/models.ts` describes each supported model: its repo, ONNX dtype,
pooling, the prefixes it wants in front of a query as against a document, its
native and stored dimensions, whether it is matryoshka (only those may be
truncated and re-normalised), and its context ceiling. The default was chosen
on measured cost; the registry's comment records the numbers.

`meta.embedding_model` is the model the index is FOR. Embedding tables are
keyed `(target, model)`, so a re-embed writes the new model's vectors beside
the old ones; the old set is deleted and the pointer moved in one transaction,
and only once the new set is complete. An interrupted re-embed therefore
leaves the old, complete index in place and simply resumes.

A re-embed discards the previous model's failure records first: a passage one
model could never read is not evidence about the next one, and keeping the row
would leave that chunk with no vector at all once the old set is deleted.

`sync`, `embed` and `search` refuse under a changed model, naming the old
model, the new one, the affected chunk count, where the change came from and
`lattice embed --reembed`. `status` reports the mismatch instead of refusing,
because `status` is how someone finds out what is wrong.

A provider failure is recorded per target in `chunk_embed_failures` /
`concept_embed_failures` as retryable or permanent. Retryable failures are
picked up by the next run; permanent ones only under
`lattice embed --retry-failed`. Both tables hang off their target, so
re-chunking a document takes its stale failure rows with it.

Environment:

| Variable | Meaning |
|---|---|
| `LATTICE_EMBED_PROVIDER` | `local` (the default), `hash`, or `stub`. An unknown name is an error, never a silent fallback. |
| `LATTICE_EMBED_MODEL` | Which registry model the `local` provider uses. Default `all-minilm-l6-v2`; also `bge-base-en-v1.5` and `nomic-embed-text-v1.5`. Names are normalised before comparison, so `Xenova/all-MiniLM-L6-v2` is the same model. |
| `LATTICE_MODEL_DIR` | A directory holding pre-placed models (`<dir>/<org>/<repo>/…`). Used as-is, with downloads switched off. |
| `HF_HUB_OFFLINE` | Refuse to download; the model must already be cached. |
| `HF_ENDPOINT` | Download from a mirror instead of `huggingface.co`. |
| `LATTICE_E2E_MODEL` | Set to `1` to run the one end-to-end test against a real downloaded model. |
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

A search under a model the index was not built with is refused outright rather
than degraded: its vectors answer a different question, so keyword-only would
be a quietly worse answer to a question nobody asked.

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

- No external services: SQLite is embedded and embeddings are computed in-process
- `@huggingface/transformers` (and its `onnxruntime-node` native runtime) is the
  one heavy dependency; it is imported lazily so commands that never embed do
  not pay for it
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
