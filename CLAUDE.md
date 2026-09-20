# Lattice - Knowledge Graph CLI

A CLI tool for syncing markdown documents with an embedded DuckDB database, enabling entity extraction and semantic search.

## Architecture

- **Backend**: DuckDB (embedded, zero external dependencies)
- **Vector Search**: DuckDB VSS extension (HNSW index with cosine similarity)
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `local` provider runs a real ONNX model through transformers.js on the user's own machine — downloaded once by `lattice init`, cached under `<LATTICE_HOME>/models`, offline thereafter. The `hash` provider stays selectable and is what the test suite drives.
- **Runtime**: Bun + NestJS

## Key Commands

```bash
lattice status   # Show documents needing sync
lattice sync     # Index the bundle, then embed whatever has no vector
lattice embed    # Embed the backlog alone (`--retry-failed` retries permanent failures, `--reembed` rebuilds under a changed model)
lattice search   # Semantic search
lattice sql      # Raw SQL queries
lattice rels     # Show a concept's links, backlinks, siblings and unresolved links
```

`lattice rels <concept>` takes either an OKF identifier (`concepts/users`) or a
bundle path (`concepts/users.md`), and `--json` prints the same four relations
machine-readably.

## Storage

All data is stored in `~/.lattice/`:
```
~/.lattice/
├── docs/                  # Markdown documentation
├── lattice.db             # Index (SQLite)
├── .sync-manifest.json    # Sync state tracking
└── models/                # Downloaded embedding models (offline after the first run)
```

Run `lattice init` to setup the directory structure.

### Database

The rewrite's index (`lattice.db`, SQLite — see `src/db/schema.ts`) holds
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
| `LATTICE_EMBED_PROVIDER` | `local` (the default) or `hash`. An unknown name is an error, never a silent fallback. |
| `LATTICE_EMBED_MODEL` | Which registry model the `local` provider uses. Default `all-minilm-l6-v2`; also `bge-base-en-v1.5` and `nomic-embed-text-v1.5`. Names are normalised before comparison, so `Xenova/all-MiniLM-L6-v2` is the same model. |
| `LATTICE_MODEL_DIR` | A directory holding pre-placed models (`<dir>/<org>/<repo>/…`). Used as-is, with downloads switched off. |
| `HF_HUB_OFFLINE` | Refuse to download; the model must already be cached. |
| `HF_ENDPOINT` | Download from a mirror instead of `huggingface.co`. |
| `LATTICE_EMBED_DIM` | Dimensions for the hash provider (default 512). The model name carries it: `hash-512`. |
| `LATTICE_EMBED_FAIL` | Fault injection for tests: `retryable:<substring>` or `permanent:<substring>` makes the provider fail on any text containing the substring. |
| `LATTICE_E2E_MODEL` | Set to `1` to run the one end-to-end test against a real downloaded model. |

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

- No services to run: SQLite is embedded and embeddings are computed in-process
- `@huggingface/transformers` (and its `onnxruntime-node` native runtime) is the
  one heavy dependency; it is imported lazily so commands that never embed do
  not pay for it
- Path utilities in `src/utils/paths.ts` for centralized storage

## Testing Philosophy

### Unit Tests (fast, pure functions)
- Test pure functions in isolation (no DB, no API calls)
- File pattern: `*.test.ts` next to the source file
- Examples: frontmatter parsing, hash computation, entity detection
- Should run in milliseconds

### Integration Tests (slow, real dependencies)
- Test actual DuckDB/API integration
- **Connect ONCE in beforeAll**, truncate tables in beforeEach
- Keep minimal - only test what unit tests can't

### When Writing Tests
1. **Prefer unit tests** - if logic can be extracted to a pure function, do it
2. **One integration test per boundary** - DB connection, API call
3. **Never beforeEach reconnect** - use beforeAll + truncate for DB tests

### Example: DuckDB Integration Test Pattern
```typescript
describe("GraphService (DuckDB)", () => {
  let graphService: GraphService;

  beforeAll(async () => {
    // Connect ONCE - extension loading is slow
    graphService = new GraphService(configService);
    await graphService.connect();
  });

  afterAll(async () => {
    await graphService.disconnect();
  });

  beforeEach(async () => {
    // Clear data, keep connection
    await graphService.query("DELETE FROM relationships");
    await graphService.query("DELETE FROM nodes");
  });
});
```
