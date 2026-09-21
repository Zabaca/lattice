---
name: search
description: Search the Lattice knowledge base and report what's already indexed — read-only, never writes new documents
---

Search the Lattice bundle for the topic given in `args` and report what is
already known. This skill is read-only: it never writes, edits, or syncs
documents. For writing new research, use the `research` skill instead.

## Where documents live

All documents live in the Lattice bundle, `~/.lattice/docs/` (or
`$LATTICE_HOME/docs` when that is set).

## Process

### Step 1: Search

When `TYPESAFE_API_KEY` is in the environment, run the judged loop first. It
plans queries, searches the index, has Jev judge the hits and rewrites when
the judge finds gaps — one command instead of several search turns:

```bash
lattice run "<topic>" --no-web --json
```

Read `exit` first:

- `answer` — report from `kept` (each `{ source, title, ref, text }`, all
  `source: "index"` here; `ref` is the bundle path) and from `completeness`
  with its `completenessLabel`. `tried` lists every query it searched.
- `decide` — the judge was unsure. Read `records[-1].probabilities` (over
  `answer`, `rewrite`, `give_up`) and choose: treat it as `answer` when
  `kept` is non-empty and the mass sits on `answer`; otherwise run
  `lattice search --json` below with your own query.
- `give_up` — nothing citable was found; say so, and run `lattice search
  --json` once to confirm before reporting a gap.

A non-zero exit (no `TYPESAFE_API_KEY`, no `CLAUDE_CODE_OAUTH_TOKEN`, no
index) prints why; say so once and fall back to the plain search. Do not
retry. The runner is read-only, like the rest of this skill.

Otherwise, or as the fallback:

```bash
lattice search "<topic>" --json
```

The JSON carries:

- `hits[]` — each with `path`, `identifier`, `title`, `type`, `status`,
  `trust`, `stale`, `score`, and `chunks[]` (the matching passages, with
  `headingPath`, `startLine`/`endLine` and a `snippet`). A hit carrying
  `expanded: true` and a `via` was reached by a link or a backlink, not by
  matching — treat it as a lead, not an answer.
- `degraded` and `degradedReason` — `true` means the semantic leg could not
  run and the answer came from keywords alone. Say so to the user; do not
  silently treat a keyword-only result as exhaustive.

Narrow when it helps: `--type Research`, `--type Topic`, `--tag <tag>`,
`--dir research` (a document's directory is named by its type), `--limit n`. Use `--concepts` to rank whole documents instead of passages,
or `--no-expand` to see only documents that actually matched.

Do not read a score as a percentage of relevance. Scores are only comparable
within one result set — open the documents behind the top hits and judge
from their text.

### Step 2: Follow up on the strongest hits

For the top few non-expanded hits, read enough of the document (or its
`chunks[].snippet`) to confirm relevance and pull out the passage that
actually answers the query.

Use `lattice rels <path>` on the most relevant document(s) to show its
links, backlinks and unresolved links — useful for
telling the user what else is connected to the topic.

### Step 3: Report

Tell the user, with paths:

- Which documents cover the topic, and which passages (`headingPath`, line
  range) are relevant.
- What the indexed documents do *not* cover — the gap, if any.
- Whether the search was degraded, and what that means for confidence.
- Whether any hit is `stale` (past its `stale_after` date) or has low
  `trust` (`unverified`) — flag it rather than presenting it as settled.

If the search surfaces a real gap and the user wants it filled, say so and
suggest running the `research` skill — do not write a new document from
within this skill.
