---
name: jev-search
description: Search the Lattice knowledge base with the judged loop (lattice run) and report from what the judge kept — read-only, never writes new documents
---

Search the Lattice bundle for the topic given in `args` with `lattice run`
and report what is already known. This skill is read-only: it never writes,
edits, or syncs documents. For writing new research, use the `research`
skill instead.

It differs from the `search` skill in one way: the runner has already
planned the queries, searched, and had Jev judge every hit, so you report
from its output and do not read the documents behind the hits again.

## Where documents live

All documents live in the Lattice bundle, `~/.lattice/docs/` (or
`$LATTICE_HOME/docs` when that is set).

## Process

### Step 1: Run

Run this once, exactly as written, and do not check the environment first:

```bash
lattice run "<topic>" --no-web --json
```

If it exits non-zero it prints why (no `TYPESAFE_API_KEY`, no
`LATTICE_OAUTH_TOKEN` — Claude Code hides `CLAUDE_CODE_OAUTH_TOKEN` from
commands, so the token has to be exported under that name — or no index). Say so in one line, run
`lattice search "<topic>" --json` once, and report from that instead.

### Step 2: Report from the output

The JSON carries:

- `exit` — `answer`, `decide` or `give_up`.
- `kept[]` — the sources the judge would cite, each `{ source, title, ref,
  text }`. `ref` is the bundle path and `text` is the matching passages.
- `completeness` (0 to 3) and `completenessLabel` — the judge's rating of
  the kept set as a whole.
- `tried[]` — every query the runner searched.
- `records[]` — one per judge visit, with `probabilities` over `answer`,
  `rewrite` and `give_up`.

Report by `exit`:

- **`answer`** — report from `kept` and `completenessLabel`. Do not run
  `lattice search`, `lattice rels`, or read the files: `text` is the
  evidence, quote from it.
- **`decide`** — the judge was unsure. Read `records[-1].probabilities`.
  When `kept` is non-empty and `answer` has the most mass, report as for
  `answer` and say the judge was unsure. Otherwise report as for `give_up`.
- **`give_up`** — say nothing citable was found for these queries, list
  `tried` so the user sees what was searched, and stop.

Tell the user, with paths:

- Which documents cover the topic, quoting the relevant passage from
  `text`.
- The completeness label, in the judge's words, and what the kept set does
  *not* cover.
- The queries in `tried`, in one line.

If the search surfaces a real gap and the user wants it filled, suggest the
`research` skill — do not write a new document from within this skill.
