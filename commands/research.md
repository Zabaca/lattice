---
description: Research a topic - searches existing docs, asks before new research
argument-hint: topic-query
model: sonnet
---

Research the topic "$ARGUMENTS" by first checking existing documentation, then performing new research if needed.

## Process

### Step 1: Search Existing Research

Run semantic search to find related documents:

```bash
lattice search "$ARGUMENTS" --limit 10
```

### Step 2: Review Search Results

Review the top results from the semantic search:

1. **Read top results** regardless of path - high similarity may indicate related content
2. **Path/title matching** is a bonus signal, not a filter
3. **Don't dismiss** high-similarity docs just because path doesn't match query
4. Use judgment after reading - the doc content determines relevance, not the filename

**Calibration notes:**
- Exact topic matches often show 30-40% similarity
- Unrelated docs can sometimes show 60%+ similarity
- Read the actual content to determine true relevance

For each promising result:
- Read the document
- Check if it answers the user's question
- Note relevant sections

### Step 3: Present Findings to User

Summarize what you found in existing docs:
- What topics are covered
- Quote relevant sections if helpful
- Identify gaps in existing research

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
- Check if a relevant `docs/{topic-name}/` directory already exists
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

**1. `docs/{topic-name}/README.md`** (index):
```markdown
---
created: [TODAY'S DATE]
updated: [TODAY'S DATE]
status: active
topic: {topic-name}
summary: >
  Brief description of the topic area for semantic search.
---

# {Topic Title}

Brief description of what this topic covers.

## Documents

| Document | Description |
|----------|-------------|
| [{Research Title}](./{research-filename}.md) | Brief description |

## Related Research

- [Related Topic](../related-topic/)
```

**2. `docs/{topic-name}/{research-filename}.md`** (content):
```markdown
---
created: [TODAY'S DATE]
updated: [TODAY'S DATE]
status: complete
topic: {topic-name}
summary: >
  Detailed summary of this specific research for semantic search.
---

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

#### For EXISTING Topics (directory exists)

**1. Create** `docs/{topic-name}/{research-filename}.md` with content template above

**2. Update** `docs/{topic-name}/README.md`:
- Add new row to the Documents table
- Update the `updated` date in frontmatter

### Step 8: Confirmation

After creating files, confirm:
- Topic directory path
- README.md created/updated
- Research file created with name
- Remind user to run `/graph-sync` to extract entities

## Important Notes

- **Do NOT** auto-run entity extraction - use `/graph-sync` separately
- **Always create README.md** for new topics (lightweight index)
- **Always create separate research file** (never put research content in README)
- Use kebab-case for all directory and file names
- Include today's date in YYYY-MM-DD format
- Always cite sources with URLs
- Cross-link to related research topics when relevant

## File Structure Standard

```
docs/{topic-name}/
├── README.md              # Index: links to docs, brief overview
├── {research-1}.md        # Specific research
├── {research-2}.md        # Additional research
└── {research-n}.md        # Expandable as needed
```

This structure allows topics to grow organically while keeping README as a clean navigation index.
