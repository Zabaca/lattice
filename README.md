# @zabaca/lattice

**Human-initiated, AI-powered knowledge graph for markdown documentation**

[![npm version](https://img.shields.io/npm/v/@zabaca/lattice.svg)](https://www.npmjs.com/package/@zabaca/lattice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

---

## Features

- **Knowledge Graph Sync** - Automatically sync entities and relationships from markdown frontmatter to a graph database
- **Semantic Search** - AI-powered search using Voyage AI embeddings for intelligent document discovery
- **Entity Extraction** - Define entities (concepts, technologies, patterns) directly in your documentation
- **Relationship Mapping** - Model connections between entities with typed relationships (USES, IMPLEMENTS, DEPENDS_ON)
- **FalkorDB Backend** - High-performance graph database built on Redis for fast queries
- **Incremental Sync** - Smart change detection syncs only modified documents
- **CLI Interface** - Simple commands for sync, search, validation, and migration

---

## Quick Start

### 1. Install Lattice

```bash
npm install -g @zabaca/lattice
```

Or with bun:

```bash
bun add -g @zabaca/lattice
```

### 2. Start FalkorDB

Using Docker Compose:

```bash
# Create docker-compose.yaml (see Infrastructure section)
docker-compose up -d
```

Or pull and run directly:

```bash
docker run -d -p 6379:6379 falkordb/falkordb:latest
```

### 3. Configure Environment

Create a `.env` file in your project root:

```bash
# FalkorDB Connection
FALKORDB_HOST=localhost
FALKORDB_PORT=6379
FALKORDB_GRAPH_NAME=lattice

# Embedding Provider (Voyage AI)
VOYAGE_API_KEY=your-voyage-api-key-here
VOYAGE_MODEL=voyage-3

# Logging
LOG_LEVEL=info
```

### 4. Initialize Claude Code Integration

Install Lattice slash commands for Claude Code:

```bash
lattice init              # For this project only
# or
lattice init --global     # For all projects (~/.claude/commands/)
```

### 5. Launch Claude Code

```bash
claude
```

### 6. Research a Topic

Use the `/research` command to search existing knowledge or create new documentation:

```bash
/research "knowledge graphs"
```

This will:
- Search your existing docs for related content
- Present findings and ask if you need new research
- Create organized documentation if requested

### 7. Sync & Search

After creating or updating documents, sync to the graph and search:

```bash
/graph-sync                    # Extract entities and sync
lattice search "your query"    # Semantic search
```

---

## Using /research

The `/research` command provides an AI-assisted research workflow.

### Searching Existing Research

```bash
/research "semantic search"
```

Claude will:
1. Search your docs using semantic similarity
2. Read and summarize relevant findings
3. Ask if existing research answers your question

### Creating New Research

```bash
/research "new topic to explore"
```

If no existing docs match, Claude will:
1. Perform web research
2. Create a new topic directory (`docs/new-topic/`)
3. Generate README.md index and research document
4. Remind you to run `/graph-sync`

### Batch Syncing

`/graph-sync` doesn't need to run after each research session. It identifies all documents needing sync:

```bash
# After multiple research sessions
/graph-sync

# Shows: "4 documents need syncing"
# Extracts entities and syncs all at once
```

---

## CLI Commands

### `lattice init`

Install Claude Code slash commands for Lattice.

```bash
lattice init              # Install to .claude/commands/ (current project)
lattice init --global     # Install to ~/.claude/commands/ (all projects)
```

### `lattice sync`

Synchronize documents to the knowledge graph.

```bash
lattice sync [paths...]         # Sync specified paths or current directory
lattice sync --force            # Force re-sync (rebuilds entire graph)
lattice sync --dry-run          # Preview changes without applying
lattice sync --verbose          # Show detailed output
lattice sync --watch            # Watch for changes and auto-sync
lattice sync --no-embeddings    # Skip embedding generation
```

### `lattice status`

Show the current sync status and pending changes.

```bash
lattice status                  # Show documents that need syncing
lattice status --verbose        # Include detailed change information
```

### `lattice search`

Semantic search across the knowledge graph.

```bash
lattice search "query"                    # Search all entity types
lattice search --label Technology "query" # Filter by entity label
lattice search --limit 10 "query"         # Limit results (default: 20)
```

### `lattice stats`

Display graph statistics.

```bash
lattice stats                   # Show node/edge counts and graph metrics
```

### `lattice validate`

Validate entity references and relationships.

```bash
lattice validate                # Check for broken references
lattice validate --fix          # Attempt to fix validation issues
```

### `lattice ontology`

Display the derived ontology from your documents.

```bash
lattice ontology                # Show entity types and relationship types
lattice ontology --format json  # Output as JSON
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FALKORDB_HOST` | FalkorDB server hostname | `localhost` |
| `FALKORDB_PORT` | FalkorDB server port | `6379` |
| `FALKORDB_GRAPH_NAME` | Name of the graph database | `lattice` |
| `VOYAGE_API_KEY` | Voyage AI API key for embeddings | *required* |
| `VOYAGE_MODEL` | Voyage AI model to use | `voyage-3` |
| `LOG_LEVEL` | Logging verbosity (debug, info, warn, error) | `info` |

### Frontmatter Schema

Lattice extracts knowledge from YAML frontmatter in your markdown files:

```yaml
---
title: Document Title
description: Brief description of the document
created: 2024-01-15
updated: 2024-01-20

entities:
  - name: React
    type: technology
    description: JavaScript library for building user interfaces
  - name: Component Architecture
    type: pattern
    description: Modular UI building blocks

relationships:
  - source: React
    target: Component Architecture
    type: IMPLEMENTS
  - source: React
    target: Virtual DOM
    type: USES
---

# Document content here...
```

### Entity Types

Common entity types (you can define your own):

- `concept` - Abstract ideas and principles
- `technology` - Tools, frameworks, and libraries
- `pattern` - Design patterns and architectural approaches
- `service` - External services and APIs
- `component` - System components and modules
- `person` - People and contributors
- `organization` - Companies and teams

### Relationship Types

Common relationship types:

- `USES` - Entity A uses Entity B
- `IMPLEMENTS` - Entity A implements Entity B
- `DEPENDS_ON` - Entity A depends on Entity B
- `EXTENDS` - Entity A extends Entity B
- `CONTAINS` - Entity A contains Entity B
- `RELATED_TO` - General relationship
- `SUPERSEDES` - Entity A replaces Entity B

---

## Infrastructure

### Docker Compose

Create `docker-compose.yaml`:

```yaml
version: '3.8'

services:
  falkordb:
    image: falkordb/falkordb:latest
    container_name: lattice-falkordb
    ports:
      - "6379:6379"
    volumes:
      - falkordb-data:/data
    environment:
      - FALKORDB_ARGS=--requirepass ""
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  falkordb-data:
    driver: local
```

Start the database:

```bash
docker-compose up -d
```

### Kubernetes (k3s)

For production deployments, use the provided k3s manifests:

```bash
# Create namespace
kubectl apply -f infra/k3s/namespace.yaml

# Deploy storage
kubectl apply -f infra/k3s/pv.yaml
kubectl apply -f infra/k3s/pvc.yaml

# Deploy FalkorDB
kubectl apply -f infra/k3s/deployment.yaml
kubectl apply -f infra/k3s/service.yaml

# Optional: NodePort for external access
kubectl apply -f infra/k3s/nodeport-service.yaml

# Optional: Ingress
kubectl apply -f infra/k3s/ingress.yaml
```

---

## Development

### Prerequisites

- Node.js >= 18.0.0
- Bun (recommended) or npm
- Docker (for FalkorDB)

### Setup

```bash
# Clone the repository
git clone https://github.com/Zabaca/lattice.git
cd lattice

# Install dependencies
bun install

# Copy environment configuration
cp .env.example .env
# Edit .env with your settings

# Start FalkorDB
docker-compose -f infra/docker-compose.yaml up -d
```

### Running Locally

```bash
# Development mode
bun run dev

# Run CLI commands during development
bun run lattice sync
bun run lattice status

# Run tests
bun test

# Build for production
bun run build
```

### Project Structure

```
lattice/
├── src/
│   ├── commands/       # CLI command implementations
│   ├── embedding/      # Voyage AI embedding service
│   ├── graph/          # FalkorDB graph operations
│   ├── query/          # Query builders and parsers
│   ├── sync/           # Document sync logic
│   ├── utils/          # Shared utilities
│   ├── app.module.ts   # NestJS application module
│   ├── cli.ts          # CLI entry point
│   └── main.ts         # Main application entry
├── infra/
│   ├── docker-compose.yaml
│   └── k3s/            # Kubernetes manifests
├── examples/           # Usage examples
└── dist/               # Build output
```

---

## API Usage

Lattice can also be used programmatically:

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@zabaca/lattice';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  // Get services
  const syncService = app.get(SyncService);
  const graphService = app.get(GraphService);

  // Sync documents
  const result = await syncService.sync({
    paths: ['./docs'],
    force: false,
    dryRun: false
  });

  console.log(`Synced ${result.added} new documents`);

  await app.close();
}
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [FalkorDB](https://www.falkordb.com/) - High-performance graph database
- [Voyage AI](https://www.voyageai.com/) - State-of-the-art embeddings
- [NestJS](https://nestjs.com/) - Progressive Node.js framework
