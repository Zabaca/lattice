# @zabaca/lattice

**Build a knowledge base with Claude Code — using your existing subscription**

[![npm version](https://img.shields.io/npm/v/@zabaca/lattice.svg)](https://www.npmjs.com/package/@zabaca/lattice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Lattice turns your markdown documentation into a searchable knowledge graph. Unlike other GraphRAG tools that require separate LLM APIs, **Lattice uses Claude Code for entity extraction** — so you're already paying for it.

## The Workflow

```bash
/research "knowledge graphs"   # Find existing docs or create new research
/graph-sync                    # Extract entities & sync (automatic)
lattice search "your query"    # Semantic search your knowledge base
```

That's it. Two commands to build a knowledge base.

---

## Why Lattice?

| Feature | Lattice | Other GraphRAG Tools |
|---------|---------|---------------------|
| **LLM for extraction** | Your Claude Code subscription | Separate API key + costs |
| **Setup time** | 5 minutes | 30+ minutes |
| **Containers** | 1 (FalkorDB) | 2-3 (DB + vector + graph) |
| **API keys needed** | 1 (Voyage AI for embeddings) | 2-3 (LLM + embedding + rerank) |
| **Workflow** | `/research` → `/graph-sync` | Custom scripts |

---

## Quick Start (5 Minutes)

### What You Need

- **Claude Code** (you probably already have it)
- **Docker** (for FalkorDB)
- **Voyage AI API key** ([get one here](https://www.voyageai.com/) - embeddings only, ~$0.01/1M tokens)

### 1. Install & Start

```bash
bun add -g @zabaca/lattice                    # Install CLI
docker run -d -p 6379:6379 falkordb/falkordb  # Start database
export VOYAGE_API_KEY=your-key-here           # Set API key
lattice init --global                         # Install Claude Code commands
```

### 2. Start Researching

```bash
claude                        # Launch Claude Code
/research "your topic"        # Find or create documentation
/graph-sync                   # Build knowledge graph (automatic)
lattice search "your query"   # Semantic search
```

### That's It!

The `/research` command will:
- Search your existing docs for related content
- Ask if you need new research
- Create organized documentation with AI assistance

The `/graph-sync` command will:
- Detect all new/changed documents
- Extract entities using Claude Code (your subscription)
- Sync to FalkorDB for semantic search

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

## CLI Reference

The Lattice CLI runs behind the scenes. You typically won't use it directly — the Claude Code slash commands handle everything.

<details>
<summary><b>CLI Commands (Advanced)</b></summary>

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
```

### `lattice status`

Show documents that need syncing.

```bash
lattice status                  # Show new/changed documents
```

### `lattice search`

Semantic search across the knowledge graph.

```bash
lattice search "query"          # Search all entity types
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
```

</details>

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VOYAGE_API_KEY` | Voyage AI API key for embeddings | *required* |
| `FALKORDB_HOST` | FalkorDB server hostname | `localhost` |
| `FALKORDB_PORT` | FalkorDB server port | `6379` |

<details>
<summary><b>How It Works (Technical Details)</b></summary>

### Entity Extraction

When you run `/graph-sync`, Claude Code extracts entities from your documents and writes them to YAML frontmatter. The Lattice CLI then syncs this to FalkorDB.

```yaml
---
entities:
  - name: React
    type: technology
    description: JavaScript library for building user interfaces

relationships:
  - source: React
    target: Component Architecture
    relation: REFERENCES
---
```

You don't need to write this manually — Claude Code handles it automatically.

</details>

---

## Infrastructure

<details>
<summary><b>Docker Compose (Alternative Setup)</b></summary>

If you prefer Docker Compose over a single `docker run` command:

```yaml
version: '3.8'

services:
  falkordb:
    image: falkordb/falkordb:latest
    ports:
      - "6379:6379"
    volumes:
      - falkordb-data:/data
    restart: unless-stopped

volumes:
  falkordb-data:
```

```bash
docker-compose up -d
```

</details>

<details>
<summary><b>Kubernetes (k3s)</b></summary>

For production deployments, use the provided k3s manifests:

```bash
kubectl apply -f infra/k3s/namespace.yaml
kubectl apply -f infra/k3s/pv.yaml
kubectl apply -f infra/k3s/pvc.yaml
kubectl apply -f infra/k3s/deployment.yaml
kubectl apply -f infra/k3s/service.yaml

# Optional: NodePort for external access
kubectl apply -f infra/k3s/nodeport-service.yaml

# Optional: Ingress
kubectl apply -f infra/k3s/ingress.yaml
```

</details>

---

## Contributing

<details>
<summary><b>Development Setup</b></summary>

### Prerequisites

- Node.js >= 18.0.0
- Bun (recommended) or npm
- Docker (for FalkorDB)

### Setup

```bash
git clone https://github.com/Zabaca/lattice.git
cd lattice
bun install
cp .env.example .env
docker-compose -f infra/docker-compose.yaml up -d
```

### Running Locally

```bash
bun run dev              # Development mode
bun test                 # Run tests
bun run build            # Build for production
```

</details>

<details>
<summary><b>Programmatic API</b></summary>

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@zabaca/lattice';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const syncService = app.get(SyncService);

  const result = await syncService.sync({
    paths: ['./docs'],
    force: false
  });

  console.log(`Synced ${result.added} new documents`);

  await app.close();
}
```

</details>

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built with [FalkorDB](https://www.falkordb.com/), [Voyage AI](https://www.voyageai.com/), and [Claude Code](https://claude.ai/code)
