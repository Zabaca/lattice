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
lattice rels     # Show relationships for a node
```

## Database

Single file storage: `.lattice.duckdb` in your docs directory. Contains:
- `nodes` table - entities with embeddings
- `relationships` table - connections between entities

## Development Notes

- No external dependencies required (DuckDB is embedded)
- Uses SQL for queries (replaced Cypher)
- VSS extension provides HNSW vector indexing
- DuckPGQ extension available for property graph queries (optional)

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
