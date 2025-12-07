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
