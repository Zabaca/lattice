# Lattice - Knowledge Graph CLI

A CLI tool for syncing markdown documents with an embedded DuckDB database, enabling entity extraction and semantic search.

## Architecture

- **Backend**: DuckDB (embedded, zero external dependencies)
- **Vector Search**: DuckDB VSS extension (HNSW index with cosine similarity)
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `local` provider runs a real ONNX model in the command's own process from weights cached under the Lattice home — no daemon, no API key, and no network after the first download. The `hash` provider is the deterministic alternative the test suite uses: 512 dimensions derived from a hash of the text, needing no model on disk.
- **Runtime**: Bun + NestJS

## Key Commands

```bash
lattice init     # Create the home directory and download the embedding model
lattice status   # Show documents needing sync
lattice sync     # Index the bundle, then embed whatever has no vector
lattice embed    # Embed the backlog alone (`--retry-failed` retries permanent failures,
                 # `--reembed` rebuilds the index after a model change)
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
├── lattice.duckdb         # Graph database
├── .sync-manifest.json    # Sync state tracking
└── .env                   # API keys (VOYAGE_API_KEY)
```

Run `lattice init` to setup the directory structure.

### Database

The rewrite's index (`lattice.db`, SQLite — see `src/db/schema.ts`) holds
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

- No external dependencies required (DuckDB is embedded)
- Uses SQL for queries (replaced Cypher)
- VSS extension provides HNSW vector indexing
- DuckPGQ extension available for property graph queries (optional)
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
