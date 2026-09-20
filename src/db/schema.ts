/**
 * The Lattice index schema.
 *
 * An OKF concept is one markdown document. It is chunked at headings, each
 * chunk carries an optional embedding and is mirrored into an FTS5 table for
 * keyword search, and authored links between documents are recorded as edges.
 *
 * This shape is a contract for the rest of the rewrite: adding columns and
 * tables later is fine, renaming them is not.
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- One row per indexed markdown document.
--
-- The OKF frontmatter fields used as retrieval filters are promoted to
-- columns; frontmatter keeps the whole parsed map, unknown keys included,
-- because the specification requires a consumer to preserve them.
-- frontmatter_error records why a document's frontmatter could not be read,
-- and is what status reports: a broken document is still indexed.
CREATE TABLE IF NOT EXISTS concepts (
	id                INTEGER PRIMARY KEY,
	path              TEXT NOT NULL UNIQUE,
	directory         TEXT NOT NULL DEFAULT '',
	title             TEXT,
	type              TEXT,
	description       TEXT,
	status            TEXT NOT NULL DEFAULT 'stable',
	stale_after       TEXT,
	trust_level       TEXT NOT NULL DEFAULT 'unverified',
	content_hash      TEXT NOT NULL,
	frontmatter       TEXT,
	frontmatter_error TEXT,
	byte_size         INTEGER NOT NULL DEFAULT 0,
	mtime_ms          INTEGER,
	indexed_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_concepts_title ON concepts(title);
CREATE INDEX IF NOT EXISTS idx_concepts_directory ON concepts(directory);
CREATE INDEX IF NOT EXISTS idx_concepts_type ON concepts(type);
CREATE INDEX IF NOT EXISTS idx_concepts_status ON concepts(status);
CREATE INDEX IF NOT EXISTS idx_concepts_content_hash ON concepts(content_hash);

-- A concept's tags, one row each, so a tag filter is an index lookup.
CREATE TABLE IF NOT EXISTS concept_tags (
	concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	tag        TEXT NOT NULL,
	PRIMARY KEY (concept_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_concept_tags_tag ON concept_tags(tag);

-- One row per heading-scoped passage of a concept.
--
-- Offsets address the ORIGINAL file, frontmatter included, so an editor can
-- open the file at the passage: start_line/end_line are 1-based and
-- inclusive, start_char/end_char are 0-based and half-open.
-- content is the indexed text — the passage with the concept title and its
-- heading path prepended — so it does not match the offsets character for
-- character.
CREATE TABLE IF NOT EXISTS chunks (
	id             INTEGER PRIMARY KEY,
	concept_id     INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	ordinal        INTEGER NOT NULL,
	heading        TEXT,
	heading_path   TEXT,
	depth          INTEGER NOT NULL DEFAULT 0,
	start_line     INTEGER NOT NULL DEFAULT 0,
	end_line       INTEGER NOT NULL DEFAULT 0,
	start_char     INTEGER NOT NULL DEFAULT 0,
	end_char       INTEGER NOT NULL DEFAULT 0,
	content        TEXT NOT NULL,
	content_hash   TEXT NOT NULL,
	token_estimate INTEGER NOT NULL DEFAULT 0,
	UNIQUE (concept_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_chunks_concept ON chunks(concept_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);

-- Keyword search over chunks. External-content: the text lives in chunks,
-- and the triggers below are the only thing keeping the two in step.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	heading_path,
	content,
	content='chunks',
	content_rowid='id',
	tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
	INSERT INTO chunks_fts(rowid, heading_path, content)
	VALUES (new.id, new.heading_path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
	INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content)
	VALUES ('delete', old.id, old.heading_path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
	INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content)
	VALUES ('delete', old.id, old.heading_path, old.content);
	INSERT INTO chunks_fts(rowid, heading_path, content)
	VALUES (new.id, new.heading_path, new.content);
END;

-- At most one embedding per chunk. The model and dimension ride with the
-- vector so a model change can be detected rather than silently mixed in.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
	chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
	model      TEXT NOT NULL,
	dim        INTEGER NOT NULL,
	vector     BLOB NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(model);

-- Authored links: wikilinks and markdown links found in a document.
CREATE TABLE IF NOT EXISTS links (
	id                INTEGER PRIMARY KEY,
	source_concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	source_chunk_id   INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
	target_concept_id INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
	target_path       TEXT,
	raw_target        TEXT NOT NULL,
	link_text         TEXT,
	kind              TEXT NOT NULL CHECK (kind IN ('wikilink', 'markdown'))
);

CREATE INDEX IF NOT EXISTS idx_links_source_concept ON links(source_concept_id);
CREATE INDEX IF NOT EXISTS idx_links_source_chunk ON links(source_chunk_id);
CREATE INDEX IF NOT EXISTS idx_links_target_concept ON links(target_concept_id);
CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);
`;
