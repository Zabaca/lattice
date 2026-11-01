# 1. Notes live in a store, not in files

Status: accepted, 2026-11-01. Slices 2 and 3 of 5 build the store, the import and the tools (reading, writing, history and undo, snapshots, export); the cutover is slice 4.

## Context

Lattice kept its notes as markdown files and built a search index from them.
That left four gaps. An agent changed a note only by rewriting its file, so
nothing recorded who changed what or why, nothing could be undone, and nothing
copied the files anywhere. A note written to a file was invisible to search
until someone ran `lattice sync`. Reaching Lattice meant running a command or a
plugin skill that was installed in two projects, so most sessions never asked it
first. And Lattice owned a research method that its owner wanted each calling
agent to choose for itself.

## Decision

The notes live in one SQLite database under `~/.lattice`, the only copy, reached
through an MCP server that every Claude Code session starts.

- A note is its fields plus an ordered list of sections. A section's text runs
  from its heading line to the next heading at any depth, so the sections
  joined in order are the note's markdown exactly. Each section has an id that
  is given once and never reused.
- Every write is one change, recorded in the transaction that makes it: the
  note, its new version, when, who, what kind, an optional reason, and the text
  or value before and after for every section and field touched. There is no
  write without a change, and nothing writes the database around the store
  module.
- The search index (passages, keyword index, vectors, links) is derived from the
  sections, as it was derived from the files, and is refreshed by every write.
  A passage whose text did not change keeps its vector.
- Markdown comes out only as an export, a copy that is never read back.
- Lattice no longer researches. It answers what is known (`recall`) and records
  what an agent tells it.

The store reuses the index's tables unchanged and adds to them (`concepts` is
the notes table; renaming it is out of scope), so search, embedding and link
reading run on a store as they ran on an index. The store is a new database
file in a new schema version, and a build refuses a schema it does not know.

## Consequences

- Only sessions on the Mac that holds `~/.lattice` can reach the notes.
- Each session's server holds the embedding model once it first needs it, about
  400 MB.
- A wrong write counts until someone undoes it, and its sections show as
  unchecked meanwhile.
- The database is the only copy. Daily snapshots guard against a bad day, not
  against losing the machine.
- Lattice 2.x stays on npm unchanged. The store ships as 3.0.0.

## Alternatives considered

Notes kept as one text each, changed by quoting (option 02 of the plan): fewer
ideas for an agent to hold, but one checked mark per note, so every agent write
unchecks the whole note, and a long note can only be read whole. Rejected.
