---
name: research-jev
description: Research a topic with the judged loop (lattice research) - the command judges the index, researches the web, writes and links the document; the skill runs it and presents the result
---

Research the topic given in `args`: one command runs the judged search loop
over the index, decides whether the bundle already answers, researches the
web when it does not, writes or extends a document from what the judge
kept, files and links it, syncs, and reports what it did. This skill runs
that command and presents its result. It never reads the kept passages,
never writes a document by hand, and never asks whether to research: the
run decides.

It differs from the `research` skill in one way: `lattice research` does
every step that skill spells out, so a session spends one command and one
report rather than a dozen turns.


## Where documents live

All documents live in the Lattice bundle, `~/.lattice/docs/` (or `$LATTICE_HOME/docs`
when that is set). The command writes there; nothing is written into a
project-local `docs/` directory.

A document lives in the directory named by its OKF `type`, lowercased and
kebab-cased, flat within that directory: `research/` for `type: Research`,
findings on a specific question; `topic/` for `type: Topic`, a hub that
describes a subject and links out to its research.


## Process

### Step 1: Run

Run this once, exactly as written, and do not check the environment first:

```bash
lattice research "<topic>" --json
```

It plans queries, searches the index, has Jev judge every result and
rewrites when the judge finds gaps; from what the judge kept it decides
`answered` (the index holds a complete answer; nothing is written),
`extend` (a research document it kept has most of the answer) or `new`.
Unless `answered`, it searches the web on the same queries — Exa first,
Claude's own WebSearch added once a round has fallen short — and has a
model write the document from the kept passages, with the hub cited, the
sources filtered to what the run read, and a wikilink added to the hub's
`## Research` section. Then it syncs and reads the relations back.

Read from the JSON:

- `decision` — `answered`, `extend` or `new`.
- `index` — `{ exit, tried, completeness, completenessLabel, kept }` of
  the index run; `kept` is bundle paths.
- `web` — the same for the web run, `kept` as `{ ref, leg?, read? }`, or
  `null` when the web was not searched.
- `document` — `{ path, action, title, hub, sources, droppedSources,
  outlinks, backlinks, unresolved }`, or `null` when nothing was written.
- `reason` — why nothing was written, when nothing was.
- `cost` — `llmUsd`, `llmCalls`, `jevInputTokens`, `webUsd`, `writeUsd`,
  `writeCalls`.
- `webReason` — a web leg that did not run, and why.

Do not run `lattice search`, `lattice run`, the `search` skill, or read the
document or the kept passages back: the JSON is the report.

If it exits non-zero it prints why. A refused document (exit 1 with
`draft` in the JSON) is reported as such: say what the problems were and
stop. A missing key is named by the command (no `TYPESAFE_API_KEY`, no
`LATTICE_OAUTH_TOKEN` — Claude Code hides `CLAUDE_CODE_OAUTH_TOKEN` from
commands, so the token has to be exported under that name — or no index).
Only when the run has named a missing key, and only when working in the
Lattice checkout, the keys are in the repo's `secrets.yaml` and the OAuth
token in `~/.claude/settings.json`:

```bash
export EXA_API_KEY=$(sops -d --extract '["EXA_API_KEY"]' secrets.yaml)
export TYPESAFE_API_KEY=$(sops -d --extract '["TYPESAFE_API_KEY"]' secrets.yaml)
export LATTICE_OAUTH_TOKEN=...   # never CLAUDE_CODE_OAUTH_TOKEN: the harness hides that name
```

If that export is refused or unavailable, do not retry it: say which key
is missing and stop. There is no by-hand fallback in this skill; the
`research` skill is the one that searches and writes by hand.

### Step 2: Present

Tell the user, from the JSON and nothing else:

- The decision, and the index run's completeness label in the judge's
  words, with the kept paths.
- When a document was written or extended: its path and title, the topic
  hub it hangs off (or that there is none), what `outlinks` say it links
  to, what `backlinks` say links to it, and anything in `unresolved` — an
  unresolved link names a document that has not been written yet, and is
  not a failure. Mention `droppedSources` when it is non-empty: those are
  citations the writer invented and the check removed.
- Which web legs ran: `web.kept[].leg` names the leg that found each page,
  and `webReason` a leg that did not run and why. Say so once; do not
  retry.
- When nothing was written, the `reason`.

Do not restate the document's content: the user can open the path.


## Notes

- One document per concept, filed under its type. The subject is in the
  filename and the `Topic` hub, never in a directory.
- The command never creates a hub. A document may name a missing one as
  `[[/topic/<name>]]`, which stays unresolved until someone writes it.
- Every document the command writes has `type`, `title`, `description`,
  `tags`, `generated` (`by: agent:lattice/research`) and `sources` holding
  only what the run read.
