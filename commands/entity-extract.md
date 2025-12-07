---
description: Extract entities from existing document and add to frontmatter
argument-hint: file-path
model: haiku
---

Extract entities and relationships from the markdown file "$ARGUMENTS" and update its frontmatter.

## IMPORTANT: Always Re-Extract

Even if the document already has frontmatter with entities:
- **RE-READ** the entire document content
- **RE-EXTRACT** entities based on CURRENT content
- **REPLACE** existing entities with fresh extraction
- **DO NOT skip** because "entities already exist"

The goal is to ensure entities reflect the document's CURRENT state, not preserve stale metadata from previous extractions.

## Process

1. **Verify file exists**:
   - Check if "$ARGUMENTS" exists
   - If not, inform user and suggest the correct path
   - Verify it's a markdown file

2. **Read and analyze the document**:
   - Read the full content of the file
   - Check for existing frontmatter
   - Analyze document context and purpose

3. **Extract entities** by identifying:
   - **Technologies**: Languages, frameworks, databases, libraries, tools mentioned
   - **Concepts**: Patterns, methodologies, theories, architectural approaches
   - **Tools & Services**: Software, platforms, applications referenced
   - **Processes**: Workflows, procedures, methodologies described
   - **Organizations**: Companies, teams, projects mentioned

   Guidelines:
   - Focus on 3-10 most significant entities for the document
   - Use specific names (e.g., "PostgreSQL" not "database")
   - Prefer proper nouns and technical terms
   - Entities should be directly relevant to the document's focus

4. **Generate document summary**:
   - Create a 2-3 sentence summary (50-100 words) that captures:
     - The document's main purpose/topic
     - Key technologies or concepts covered
     - Primary conclusions or recommendations (if any)

   Summary guidelines:
   - Write in third person
   - Include key terms that enable semantic search
   - Focus on what the document IS ABOUT, not just what it contains
   - Make it suitable for embedding generation

   Example:
   ```yaml
   summary: >
     Research on integrating multiple messaging platforms (Slack, Teams, Discord)
     into a unified API. Covers platform API comparisons, recommended tech stack
     (NestJS, PostgreSQL, Redis), and a phased implementation approach for
     bi-directional message synchronization.
   ```

5. **Extract relationships** between entities:
   - **REFERENCES**: This entity references/relates to another entity

   Use `source: this` when the document itself references an entity.
   Use entity names as source/target when entities reference each other.

6. **Determine entity types** (choose most appropriate):
   - `Topic`: Research domains (usually auto-derived from directory)
   - `Technology`: Programming languages, frameworks, databases
   - `Concept`: Patterns, theories, methodologies
   - `Tool`: Software, services, platforms
   - `Process`: Workflows, procedures, methodologies
   - `Person`: People
   - `Organization`: Companies, teams, projects

7. **Update frontmatter**:
   - If frontmatter exists: **REPLACE** entities and relationships with fresh extraction
   - If no frontmatter: Create new frontmatter block
   - Preserve existing fields like `created`, `status`, `topic` (but update `updated` date)
   - **Replace** the `summary`, `entities` and `relationships` sections entirely
   - If no topic field exists, derive it from the directory name
     (e.g., `~/.lattice/docs/claude-code/file.md` -> `topic: claude-code`)

   Frontmatter template:
   ```yaml
   ---
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   status: complete|ongoing|draft
   topic: auto-derived-from-directory
   summary: >
     2-3 sentence summary capturing the document's purpose, key topics,
     and conclusions. Written in third person with key terms for semantic search.
   entities:
     - name: EntityName
       type: Topic|Technology|Concept|Tool|Process|Person|Organization
       description: Brief description of entity and its role in this document
     - name: AnotherEntity
       type: Concept
       description: Another entity description
   relationships:
     - source: this
       relation: REFERENCES
       target: MainTopic
     - source: EntityA
       relation: REFERENCES
       target: EntityB
   graph:
     domain: detected-domain
   ---
   ```

8. **Entity naming consistency**:
   - Check if similar entities exist in other documents
   - Use exact same names when referring to same entities
   - Be specific: "React" not "React library"
   - Use canonical names (e.g., "TypeScript" not "TS")

9. **Relationship guidelines**:
   - Start with "source: this" for primary entity the document covers
   - Include 3-7 key relationships
   - Relationships should help build knowledge graph connections
   - Avoid redundant relationships

10. **Validate and auto-fix** (retry loop):
    After saving, run validation:

    ```bash
    lattice validate 2>&1 | grep -A10 "$ARGUMENTS"
    ```

    **If validation reports errors for this file:**
    1. Parse the error message to identify the issue
    2. Fix the frontmatter:
       - **Invalid entity type** (e.g., "Platform", "Feature"): Change to valid type
       - **Invalid relation** (e.g., "AFFECTS", "ENABLES"): Change to valid relation
       - **String instead of object**: Reformat to proper object structure
    3. Save the fixed frontmatter
    4. Re-run validation
    5. Repeat until validation passes (max 3 attempts)

    **Valid entity types:** `Topic`, `Technology`, `Concept`, `Tool`, `Process`, `Person`, `Organization`, `Document`

    **Valid relations:** `REFERENCES`

11. **Confirmation**:
    - Show the file path
    - Show the generated summary
    - List extracted entities with types
    - List extracted relationships
    - Confirm validation passed (or show fixes made)

## Important Notes

- **Preserve existing content**: Do not modify the markdown content itself, only the frontmatter
- **YAML validity**: Ensure all YAML is properly formatted
- **Replace strategy**: Always replace entities/relationships with fresh extraction (don't merge with old)
- **Be selective**: Focus on entities that would be valuable for knowledge graph connections
- **Descriptions**: Write descriptions from the perspective of how the entity is used/discussed in THIS document
