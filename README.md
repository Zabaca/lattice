# @zabaca/lattice

**Build a knowledge base with Claude Code — using your existing subscription**

[![npm version](https://img.shields.io/npm/v/@zabaca/lattice.svg)](https://www.npmjs.com/package/@zabaca/lattice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Lattice turns your markdown documentation into a searchable knowledge graph. Unlike other GraphRAG tools that require separate LLM APIs, **Lattice uses Claude Code for entity extraction** — so you're already paying for it.

## The Workflow

```bash
/research "knowledge graphs"   # Find existing docs, create new research, auto-sync
lattice search "your query"    # Semantic search your knowledge base
```

That's it. One command to build a knowledge base.

---

## Why Lattice?

| Feature | Lattice | Other GraphRAG Tools |
|---------|---------|---------------------|
| **LLM for extraction** | Your Claude Code subscription | Separate API key + costs |
| **Setup time** | 2 minutes | 30+ minutes |
| **Database** | Embedded DuckDB (zero config) | Docker containers required |
| **External dependencies** | None | 2-3 (DB + vector + graph) |
| **API keys needed** | 1 (Voyage AI for embeddings) | 2-3 (LLM + embedding + rerank) |
| **Workflow** | `/research` (auto-syncs) | Custom scripts |

---

## Quick Start (2 Minutes)

### What You Need

- **Claude Code** (you probably already have it)
- **Voyage AI API key** ([get one here](https://www.voyageai.com/) - embeddings only, ~$0.01/1M tokens)

### 1. Install

```bash
bun add -g @zabaca/lattice          # Install CLI
export VOYAGE_API_KEY=your-key-here  # Set API key
lattice init --global                # Install Claude Code commands
```

That's it. No Docker. No containers. DuckDB is embedded.

### 2. Start Researching

```bash
claude                        # Launch Claude Code
/research "your topic"        # Find or create documentation (auto-syncs)
lattice search "your query"   # Semantic search
```

### That's It!

The `/research` command will:
- Search your existing docs for related content
- Ask if you need new research
- Create organized documentation with AI assistance
- **Automatically sync** to the knowledge graph

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
2. Create a new topic directory (`~/.lattice/docs/new-topic/`)
3. Generate README.md index and research document
4. Automatically sync to the knowledge graph

---

## Question Tracking

Track research questions and link them to answers in your knowledge base.

```bash
lattice question:add "How does X work?"           # Track a question
lattice question:link "How does X work?" --doc ~/.lattice/docs/topic/answer.md  # Link to answer
lattice question:unanswered                       # Find unanswered questions
```

Questions become searchable entities with `ANSWERED_BY` relationships to documents.

---

## P2P Knowledge Sharing

Share your research with others via encrypted peer-to-peer transfer.

```bash
# Sender
lattice share duckdb                    # Share the duckdb topic
# Output: 5443-madam-bandit-river

# Receiver
lattice receive 5443-madam-bandit-river # Receive and auto-sync to graph
```

Uses [croc](https://github.com/schollz/croc) for secure transfers. The binary is auto-downloaded on first use.

---

## Site Generation

Generate a browsable documentation site from your knowledge base.

```bash
lattice site              # Build and serve at localhost:4321
lattice site --build      # Build only (output to .lattice/site/)
```

Uses [Astro](https://astro.build/) with a clean documentation theme. Your entities and relationships become navigable pages.

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
lattice search "query" -l Tool  # Filter by label
```

### `lattice sql`

Execute raw SQL queries against DuckDB.

```bash
lattice sql "SELECT * FROM nodes LIMIT 10"
lattice sql "SELECT label, COUNT(*) FROM nodes GROUP BY label"
```

### `lattice rels`

Show relationships for a node.

```bash
lattice rels "TypeScript"       # Show all relationships for an entity
```

### `lattice ontology`

Display the derived ontology from your documents.

```bash
lattice ontology                # Show entity types and relationship types
```

### `lattice site`

Build and serve a documentation site.

```bash
lattice site                    # Build and serve at localhost:4321
lattice site --build            # Build only (output to .lattice/site/)
```

### `lattice share`

Share a topic directory via P2P transfer.

```bash
lattice share <path>            # Share docs, outputs a receive code
```

### `lattice receive`

Receive shared documents.

```bash
lattice receive <code>          # Receive and auto-sync to graph
lattice receive <code> --no-sync  # Receive without syncing
```

### `lattice question:add`

Track a research question.

```bash
lattice question:add "question"                    # Create question entity
lattice question:add "question" --answered-by path # Create and link
```

### `lattice question:link`

Link a question to an answering document.

```bash
lattice question:link "question" --doc path
```

### `lattice question:unanswered`

List questions without answers.

```bash
lattice question:unanswered
```

</details>

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VOYAGE_API_KEY` | Voyage AI API key for embeddings | *required* |
| `DUCKDB_PATH` | Path to DuckDB database file | `~/.lattice/lattice.duckdb` |
| `EMBEDDING_DIMENSIONS` | Embedding vector dimensions | `512` |

### Database Location

Lattice stores its knowledge graph in `~/.lattice/lattice.duckdb`. This file contains:
- All extracted entities (nodes)
- Relationships between entities
- Vector embeddings for semantic search

You can back up, copy, or version control this file like any other.

<details>
<summary><b>How It Works (Technical Details)</b></summary>

### Entity Extraction

When you run `/research` or `lattice sync`, Claude Code extracts entities from your documents and writes them directly to the DuckDB database. No frontmatter required — your markdown files stay clean.

The extraction identifies:
- **Entities**: People, technologies, concepts, tools, etc.
- **Relationships**: How entities connect to each other
- **Document metadata**: Title, summary, topic classification

### Database Schema

Lattice uses two main tables:

```sql
-- Nodes (entities)
CREATE TABLE nodes (
    label VARCHAR NOT NULL,      -- Entity type: Document, Technology, etc.
    name VARCHAR NOT NULL,       -- Unique identifier
    properties JSON,             -- Additional metadata
    embedding FLOAT[512],        -- Vector for semantic search
    PRIMARY KEY(label, name)
);

-- Relationships
CREATE TABLE relationships (
    source_label VARCHAR NOT NULL,
    source_name VARCHAR NOT NULL,
    relation_type VARCHAR NOT NULL,
    target_label VARCHAR NOT NULL,
    target_name VARCHAR NOT NULL,
    properties JSON,
    PRIMARY KEY(source_label, source_name, relation_type, target_label, target_name)
);
```

### Vector Search

Lattice uses DuckDB's VSS extension for HNSW-based vector similarity search with cosine distance.

</details>

---

## Contributing

<details>
<summary><b>Development Setup</b></summary>

### Prerequisites

- Node.js >= 18.0.0
- Bun (recommended) or npm

### Setup

```bash
git clone https://github.com/Zabaca/lattice.git
cd lattice
bun install
cp .env.example .env
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

Built with [DuckDB](https://duckdb.org/), [Voyage AI](https://www.voyageai.com/), and [Claude Code](https://claude.ai/code)
