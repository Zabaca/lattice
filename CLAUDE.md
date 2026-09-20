# Lattice - Knowledge Graph CLI

A CLI tool for syncing markdown documents with an embedded DuckDB database, enabling entity extraction and semantic search.

## Architecture

- **Backend**: DuckDB (embedded, zero external dependencies)
- **Vector Search**: DuckDB VSS extension (HNSW index with cosine similarity)
- **Embeddings**: Voyage AI (voyage-3-lite, 512 dimensions)
- **Runtime**: Bun + NestJS

## Key Commands

```bash
lattice status   # Show documents needing sync
lattice sync     # Sync documents to DuckDB
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

Contains:
- `nodes` table - entities with embeddings
- `relationships` table - connections between entities

The rewrite's index (`lattice.db`, SQLite — see `src/db/schema.ts`) instead holds
`concepts`, `chunks`, `chunks_fts`, `chunk_embeddings` and `links`.

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
