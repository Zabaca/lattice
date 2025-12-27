---
description: Research a topic - searches existing docs, asks before new research
argument-hint: topic-query
model: sonnet
---

Research the topic "$ARGUMENTS" by first checking existing documentation, then performing new research if needed.

## Configuration

**CRITICAL: All documentation lives in `~/.lattice/docs/`**

| Path | Purpose |
|------|---------|
| `~/.lattice/docs/` | Root documentation directory (ALWAYS use this) |
| `~/.lattice/docs/{topic}/` | Topic directories |
| `~/.lattice/docs/{topic}/README.md` | Topic index |
| `~/.lattice/docs/{topic}/*.md` | Research documents |

**NEVER use project-local `docs/` directories. ALWAYS use absolute path `~/.lattice/docs/`.**

## Process

### Step 1: Create or Find Question

First, search to see if this question (or similar) already exists:

```bash
lattice search "$ARGUMENTS" --limit 5
```

Look for results with `[Question]` label and high similarity (>70%).

**If similar question exists:** Use that existing question (don't duplicate).

**If no similar question:** Create the question entity:

```bash
lattice question:add "$ARGUMENTS"
```

This ensures the question is tracked regardless of whether we find an answer.

### Step 2: Search for Answers

Search for documents that might answer this question:

```bash
lattice search "$ARGUMENTS" --limit 10
```

Review results focusing on:
- Documents (`[Document]` label) with relevant content
- High similarity scores (>40% often indicates relevance)

**Calibration notes:**
- Exact topic matches often show 30-40% similarity
- Unrelated docs can sometimes show 60%+ similarity
- Read the actual content to determine true relevance

For each promising result:
- Read the document
- Check if it answers the user's question
- Note relevant sections

### Step 3: Present Findings and Link Answer

Summarize what you found in existing docs:
- What topics are covered
- Quote relevant sections if helpful
- Identify gaps in existing research

**If existing documentation answers the question:**

Link the question to the answering document:

```bash
lattice question:link "$ARGUMENTS" --doc {path-to-doc}
```

Ask the user: **"Does this existing research cover your question?"**

### Step 4: Ask About New Research

Use AskUserQuestion to ask:
- **"Should I perform new research on this topic?"**
- Options:
  - Yes, research and create new docs
  - Yes, research and update existing docs
  - No, existing research is sufficient

If user says **No** → Done, conversation complete.

### Step 5: Perform Research (if requested)

If user wants new research:
1. Use WebSearch to find current information
2. Gather and synthesize findings
3. Focus on what's missing from existing docs

### Step 6: Determine Topic and Filename

**Identify the topic directory:**
- Check if a relevant `~/.lattice/docs/{topic-name}/` directory already exists
- If not, derive a new topic name from the query (kebab-case)

**Derive the research filename:**
Auto-derive from the specific focus of the query:

| Query | Topic Dir | Research File |
|-------|-----------|---------------|
| "tesla model s value retention" | `tesla-model-s/` | `value-retention.md` |
| "bun vs node performance" | `bun-nodejs/` | `performance-comparison.md` |
| "graphql authentication patterns" | `graphql/` | `authentication-patterns.md` |

**Filename guidelines:**
- Use kebab-case
- Be descriptive of the specific research focus
- Avoid generic names like `notes.md` or `research.md`
- Keep it concise (2-4 words)

### Step 7: Create/Update Files

#### For NEW Topics (directory doesn't exist)

Create TWO files:

**1. `~/.lattice/docs/{topic-name}/README.md`** (index):
```markdown
# {Topic Title}

Brief description of what this topic covers.

## Documents

| Document | Description |
|----------|-------------|
| [{Research Title}](./{research-filename}.md) | Brief description |

## Related Research

- [Related Topic](../related-topic/)
```

**2. `~/.lattice/docs/{topic-name}/{research-filename}.md`** (content):
```markdown
# {Research Title}

## Purpose

What this research addresses.

## Key Findings

- Finding 1
- Finding 2

## [Content sections as needed...]

## Sources

1. [Source](URL)
```

**Note:** No frontmatter required - entities, relationships, and summaries are automatically extracted by AI during `lattice sync`.

#### For EXISTING Topics (directory exists)

**1. Create** `~/.lattice/docs/{topic-name}/{research-filename}.md` with content template above

**2. Update** `~/.lattice/docs/{topic-name}/README.md`:
- Add new row to the Documents table

### Step 8: Sync and Link Question

After creating files, sync to the knowledge graph:

```bash
lattice sync
```

This will:
- Add documents to the graph
- Extract entities automatically via AI
- Generate embeddings for semantic search

Then link the question to the new document:

```bash
lattice question:link "$ARGUMENTS" --doc ~/.lattice/docs/{topic-name}/{research-filename}.md
```

### Step 9: Confirmation

Confirm to the user:
- Question entity created/found
- Topic directory path
- Research file created
- Question linked to document via ANSWERED_BY
- Sync completed

## Important Notes

- **Always create README.md** for new topics (lightweight index)
- **Always create separate research file** (never put research content in README)
- Use kebab-case for all directory and file names
- Always cite sources with URLs
- Cross-link to related research topics when relevant
- **No frontmatter needed** - AI extracts entities automatically during sync
- **Questions track user intent** - even if a doc exists, the question helps future discovery

## File Structure Standard

```
~/.lattice/docs/{topic-name}/
├── README.md              # Index: links to docs, brief overview
├── {research-1}.md        # Specific research
├── {research-2}.md        # Additional research
└── {research-n}.md        # Expandable as needed
```

This structure allows topics to grow organically while keeping README as a clean navigation index.

## Question Commands Reference

| Command | Purpose |
|---------|---------|
| `lattice question:add "question"` | Create a question entity |
| `lattice question:add "question" --answered-by path` | Create and link in one step |
| `lattice question:link "question" --doc path` | Link question to answering doc |
| `lattice question:unanswered` | List questions without answers |
