# Lattice - Knowledge Graph CLI

A CLI tool for syncing markdown documents with an embedded DuckDB database, enabling entity extraction and semantic search.

## Architecture

- **Backend**: DuckDB (embedded, zero external dependencies)
- **Vector Search**: DuckDB VSS extension (HNSW index with cosine similarity)
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `hash` provider is deterministic — 512 dimensions derived from a hash of the text — so the pipeline needs no model on disk and no network.
- **Runtime**: Bun + NestJS

## Key Commands

```bash
lattice status   # Show documents needing sync
lattice sync     # Index the bundle, then embed whatever has no vector
lattice embed    # Embed the backlog alone (`--retry-failed` retries permanent failures)
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
