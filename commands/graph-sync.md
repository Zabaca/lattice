---
description: Sync modified docs to knowledge graph
model: sonnet
---

Sync modified documents in `~/.lattice/docs/` to the knowledge graph.

## Configuration

**⚠️ CRITICAL: All documentation lives in `~/.lattice/docs/`**

| Path | Purpose |
|------|---------|
| `~/.lattice/docs/` | Root documentation directory (ALWAYS use this) |
| `~/.lattice/docs/{topic}/` | Topic directories |
| `~/.lattice/docs/{topic}/*.md` | Research documents |

**NEVER use project-local `docs/` directories. ALWAYS use absolute path `~/.lattice/docs/`.**

## Process

### Step 1: Check What Needs Syncing

Run the status command to identify modified documents:

```bash
lattice status
```

This will show:
- **New** documents not yet in the graph
- **Updated** documents that have changed since last sync

If no documents need syncing, report that and exit.

### Step 2: Sync to Graph

Run sync to process all changed documents:

```bash
lattice sync
```

This will automatically:
- **Extract entities** using AI (Claude Haiku) for each new/updated document
- **Generate embeddings** for semantic search
- **Create entity relationships** in the graph
- **Update the sync manifest** with new hashes

The sync command includes built-in rate limiting (500ms between extractions) to avoid API throttling.

### Step 3: Report Results

Summarize what was processed:
- Number of documents synced
- Entities extracted per document
- Graph sync statistics (added, updated, unchanged)
- Any errors encountered

## Example Output

```
## Graph Sync

lattice status:
- 3 documents need syncing (2 new, 1 updated)

lattice sync:
- ~/.lattice/docs/american-holidays/README.md → 4 entities extracted
- ~/.lattice/docs/american-holidays/thanksgiving-vs-christmas.md → 8 entities extracted
- ~/.lattice/docs/bun-nestjs/notes.md → 5 entities extracted

Summary:
- Added: 2
- Updated: 1
- Unchanged: 126
- Duration: 3.2s
```

## Important Notes

- **AI extraction is automatic** - no need for manual `/entity-extract` calls
- **Incremental sync** - only processes changed documents
- **Self-correcting** - Claude validates extractions and fixes errors automatically
- **Safe to run frequently** - won't duplicate or corrupt data
- **No frontmatter required** - documents are plain markdown
- **Batch syncing** - run once after multiple research sessions for efficiency
