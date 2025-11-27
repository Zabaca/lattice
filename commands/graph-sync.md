---
description: Extract entities from modified docs and sync to graph
model: sonnet
---

Identify modified documents, extract entities from them, and sync to the knowledge graph.

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

### Step 2: Run Entity Extraction (Parallel Execution)

For each new or updated document identified:

1. Use the **Task subagent pattern** with Haiku model for parallel execution
2. Launch multiple Task agents simultaneously (one per document)
3. Each agent should:
   - Invoke `/entity-extract <path>`
   - Follow expanded instructions
   - Extract entities and update frontmatter
   - Report completion

**Example Task agent invocation:**
```
Task(
  subagent_type="general-purpose",
  model="haiku",
  prompt="Use /entity-extract docs/topic/document.md to extract entities. Follow all instructions and report completion."
)
```

**For multiple documents, launch agents in parallel:**
```
// In a single message, launch multiple Task tool calls:
Task(subagent_type="general-purpose", model="haiku", prompt="/entity-extract docs/topic-a/README.md ...")
Task(subagent_type="general-purpose", model="haiku", prompt="/entity-extract docs/topic-b/notes.md ...")
Task(subagent_type="general-purpose", model="haiku", prompt="/entity-extract docs/topic-c/README.md ...")
```

This is much faster than sequential execution for multiple documents.

### Step 3: Sync to Graph

After all entity extractions are complete:

```bash
lattice sync
```

**Note:** The sync command validates frontmatter schema and will fail with errors if:
- Entities are malformed (strings instead of objects with `name`/`type`)
- Relationships are malformed (strings instead of objects with `source`/`relation`/`target`)

If sync fails due to schema errors, the entity extraction didn't follow the correct format.

This will:
- Update document nodes in FalkorDB
- Generate embeddings for semantic search
- Create entity relationships
- Update the sync manifest

### Step 4: Report Results

Summarize what was processed:
- Number of documents with entity extraction
- Entities extracted per document
- Graph sync statistics (added, updated, unchanged)
- Any errors encountered

## Example Output

```
## Entity Extraction

Processed 3 documents:

1. docs/american-holidays/README.md
   - 4 entities extracted
   - 3 relationships defined

2. docs/american-holidays/thanksgiving-vs-christmas.md
   - 8 entities extracted
   - 5 relationships defined

3. docs/bun-nestjs/notes.md
   - 5 entities extracted
   - 4 relationships defined

## Graph Sync

- Added: 2
- Updated: 1
- Unchanged: 126
- Duration: 1.2s
```

## Important Notes

- **Parallel execution** - Launch all entity extractions simultaneously for speed
- Entity extraction runs per-document for quality
- Graph sync is incremental (only processes changes)
- Safe to run frequently - won't duplicate or corrupt data
- If extraction fails on a doc, other agents continue - report all errors at end
- **Batch syncing**: You don't need to run after each `/research` - run once after multiple sessions
