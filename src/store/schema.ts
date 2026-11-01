/**
 * The note store's schema.
 *
 * The store is the index's tables plus what the index never had: the notes'
 * own text, kept as sections, and the changes that made them. The derived
 * tables (`chunks`, `chunks_fts`, the embeddings, `links`, `tags`) are exactly
 * today's, so search, embedding and link reading run on a store unchanged.
 * `concepts` is the notes table; renaming it is out of scope.
 *
 * A note's `path` is its name plus `.md`. No file exists: it is the address a
 * relative link resolves against, so link extraction stays as it is.
 *
 * Everything the index holds can be rebuilt from `sections` and the note's
 * fields; `sections` and `changes` cannot be rebuilt from anything.
 */

import { SCHEMA_SQL } from "../db/schema.js";

/**
 * The store counts its own layouts, apart from the index's: its `meta.kind` says
 * it is a store, so an index at the same number is not mistaken for one. An
 * older or newer build refuses a version it does not know. The tables below are
 * the index's as of schema 5; if the index's schema changes, the store's layout
 * changes with it, and `store.test.ts` pins the layout so that shows up there.
 */
export const STORE_SCHEMA_VERSION = 1;

export const STORE_SCHEMA_SQL = `${SCHEMA_SQL}

-- What a note has that a file-backed concept did not.
ALTER TABLE concepts ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
-- The note's version: it rises by one with every change to it.
ALTER TABLE concepts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE concepts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
-- The number the next section of this note is given. Never goes down, so a
-- removed section's id is never reused.
ALTER TABLE concepts ADD COLUMN next_section INTEGER NOT NULL DEFAULT 1;
ALTER TABLE concepts ADD COLUMN created_at TEXT;
ALTER TABLE concepts ADD COLUMN updated_at TEXT;

-- The passage's section: the one its first line sits in.
ALTER TABLE chunks ADD COLUMN section_id TEXT;

-- The old names a note answers to after a rename.
CREATE TABLE IF NOT EXISTS note_names (
	name       TEXT PRIMARY KEY,
	concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE
);

-- A note's text: its sections in order. 'text' runs from the section's heading
-- line to the next heading line at any depth, heading line included, so the
-- sections joined in order are the note's markdown exactly. 'sid' is the
-- section's id within its note (s1, s2, ...), given once and never reused.
-- 'trust' is checked-ness: unverified, machine-confirmed (an agent checked
-- it) or human-reviewed (James did).
CREATE TABLE IF NOT EXISTS sections (
	id         INTEGER PRIMARY KEY,
	concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	sid        TEXT NOT NULL,
	position   INTEGER NOT NULL,
	depth      INTEGER NOT NULL,
	heading    TEXT,
	text       TEXT NOT NULL,
	version    INTEGER NOT NULL DEFAULT 1,
	trust      TEXT NOT NULL DEFAULT 'unverified'
		CHECK (trust IN ('unverified', 'machine-confirmed', 'human-reviewed')),
	checked_by TEXT,
	checked_at TEXT,
	UNIQUE (concept_id, sid)
);

CREATE INDEX IF NOT EXISTS idx_sections_order ON sections(concept_id, position);

-- Every write is one change. It is written in the same transaction as the
-- write, so there is no write without one. A note's versions are its changes'
-- 'version' values, one per change.
CREATE TABLE IF NOT EXISTS changes (
	id         INTEGER PRIMARY KEY,
	concept_id INTEGER NOT NULL REFERENCES concepts(id),
	version    INTEGER NOT NULL,
	at         TEXT NOT NULL,
	kind       TEXT NOT NULL,
	reason     TEXT,
	-- Who: the MCP client, the project folder the session runs in, and an
	-- optional name the caller gave itself.
	client     TEXT,
	project    TEXT,
	by_name    TEXT,
	-- The change this one undid, when it is an undo.
	undoes     INTEGER REFERENCES changes(id),
	UNIQUE (concept_id, version)
);

CREATE INDEX IF NOT EXISTS idx_changes_at ON changes(at);
CREATE INDEX IF NOT EXISTS idx_changes_undoes ON changes(undoes);

-- What a change did to each section it touched: the text before and after.
-- 'before_prev' and 'after_prev' say where the section stood (the section it
-- followed, '' for the start, NULL when the change did not move it) rather
-- than as a number, because a number would be wrong again the moment another
-- section was added above it.
CREATE TABLE IF NOT EXISTS change_sections (
	change_id      INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
	sid            TEXT NOT NULL,
	op             TEXT NOT NULL CHECK (op IN ('insert', 'update', 'remove', 'move', 'check')),
	before_text    TEXT,
	after_text     TEXT,
	before_heading TEXT,
	after_heading  TEXT,
	before_depth   INTEGER,
	after_depth    INTEGER,
	before_prev    TEXT,
	after_prev     TEXT,
	before_trust   TEXT,
	after_trust    TEXT,
	PRIMARY KEY (change_id, sid)
);

-- What a change did to each field it touched, as JSON.
CREATE TABLE IF NOT EXISTS change_fields (
	change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
	field     TEXT NOT NULL,
	before    TEXT,
	after     TEXT,
	PRIMARY KEY (change_id, field)
);

-- Each recall: when, where from and what was asked. Only 'stats' and the CLI
-- read it, so the first week's use can be counted.
CREATE TABLE IF NOT EXISTS recall_log (
	id       INTEGER PRIMARY KEY,
	at       TEXT NOT NULL,
	project  TEXT,
	client   TEXT,
	question TEXT NOT NULL,
	results  INTEGER NOT NULL,
	degraded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recall_log_at ON recall_log(at);
`;
